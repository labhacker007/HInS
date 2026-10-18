# consent-service — consent ledger + approval round trip

docs/PLATFORM_BLUEPRINT.md §04's consent ledger service. Owns every
consent event as an immutable, append-only record (one documented
exception — see `src/db/schema.ts`'s header) and is the only writer of
`@hins/shared`'s `ConsentRecord`.

## What it does

`POST /consents` creates a consent record. A patient granting their own
consent directly lands as `status='granted'` immediately. A
clinician-initiated request (`requiresApproval: true`) instead lands as
`status='pending'` and only becomes `granted` (via
`POST /consents/:id/approve`) or `revoked` (via `POST /consents/:id/deny`,
with a `statusNote`) once the patient themselves decides — the "Consent
approval round trip" closed in blueprint §16's Decisions log.
`POST /consents/:id/revoke` lets a patient revoke an already-active grant
at any time, independent of the approval flow.

## What this does and doesn't mean

**Caller-identity enforcement on approve/deny (this update).**
`POST /consents/:id/approve` and `.../deny` previously had **no caller
check at all** — anyone who knew a pending consent record's id could
approve or deny it, impersonating the patient. That gap was explicitly
tracked in blueprint §16 ("neither endpoint checks that the caller is
actually the patient the pending request is for"). It's now closed the
same way `audit-service`/`deid-service` close their own caller-identity
gaps:

- Both routes now require `Authorization: Bearer <token>` for a real
  Medplum caller on this project, resolved via Medplum's own
  `GET /auth/me` — **not** a locally-decoded JWT, and not a forwarded-
  token resource read (that approach was tried and found spoofable when
  `audit-service`/`deid-service` built the same kind of check first; see
  `src/index.ts`'s `resolveCaller` header comment here, and
  `services/audit-service/src/index.ts`'s for the full research writeup
  — not repeated in every service). No token, or a token that doesn't
  resolve → `401`.
- The resolved caller must be a **Patient** whose id equals the pending
  record's `grantorPatientId` — the one patient this specific request is
  actually for. A Practitioner (any practitioner, admin role or not —
  this check is deliberately not an admin override, since the entire
  point of the approval step is that the patient decides) or a
  *different* Patient → `403`, naming which patient id is required and
  what the caller actually resolved to.
- This is duplicated in this service's own `src/index.ts`
  (`resolveCaller` + `requirePatientOwnerCaller`), not factored into a
  shared package — matching this codebase's existing "each service
  duplicates its own auth-resolution logic" convention (blueprint §16).
  It's also a **generalization**, not a copy, of `audit-service`'s
  `resolveCaller`: that one only ever resolves a `Practitioner/<id>`
  (every audit-service caller is clinical staff); this service's
  approve/deny callers are patients, so this version reads
  `membership.profile.reference` for either a `Practitioner/` or
  `Patient/` prefix and reports which kind it resolved.
- The 404 (unknown consent id) and 409 (record isn't `status=pending`)
  checks already in these handlers run **first**, unchanged — the auth
  gate only runs once there's an actual pending record to check caller
  identity against, so a stray/garbage id or an already-decided record
  still gets its original 404/409 rather than a 401/403 that would leak
  whether the id even exists.

**What this still does NOT model — stated plainly, not glossed over: a
legal representative/guardian approving on the patient's behalf.**
`CreateConsentSchema` has an optional `grantor.representative` field
(`personId` + `relationship`) for exactly that real-world case — a
parent consenting for a minor, a guardian for a patient who can't
consent themselves — but the new ownership check only ever accepts the
resolved caller being the grantor **patient** themselves
(`Patient/<grantorPatientId>`). A representative's own Medplum identity
is never accepted here, even when one was correctly recorded as
`grantor.representative` on the original request. Representative-
initiated approval remains unbuilt and is tracked as an open item in
blueprint §16, not silently dropped.

**Still the same underlying trade-off as every other service's version of
this check:** one live network call to Medplum (`GET /auth/me`) per
authenticated request, not local JWT/JWKS verification — correct, adds
latency, same documented follow-up as `audit-service`/`deid-service`.

## API

```
POST /consents
  { type, grantor: { patientId, representative? }, scope[], purposeCode,
    requester: { id, displayName, externalRef? }, validity: { start, expiry },
    signature?, requiresApproval? }
  -> 201 ConsentRecord (status='pending' if requiresApproval, else 'granted')

GET /consents?patientId=...
  -> active grants only (status=granted, not expired, not later revoked)

GET /consents/history?patientId=...
  -> every record for this patient, unfiltered (including pending/revoked)

POST /consents/:id/revoke
  { recipients: string[] }
  -> 200 ConsentRecord (new 'revoked' row) | 404 | 409 (not an active original grant)

POST /consents/:id/approve
  Requires Authorization: Bearer <Medplum access token> for the Patient
  this pending request is for.
  {} -> 200 ConsentRecord (status='granted') | 401 | 403 | 404 | 409 (not pending)

POST /consents/:id/deny
  Requires Authorization: Bearer <Medplum access token> for the Patient
  this pending request is for.
  { note? } -> 200 ConsentRecord (status='revoked', statusNote set) | 401 | 403 | 404 | 409 (not pending)
```

## Try it (needs infra + Medplum login for a real HInS Dev patient)

```bash
# 1. Clinician-initiated request, lands as pending
curl -s -X POST http://localhost:4001/consents -H 'content-type: application/json' -d '{
  "type": "data_sharing",
  "grantor": { "patientId": "<real Patient id>" },
  "scope": ["OPDRecord"],
  "purposeCode": "treatment",
  "requester": { "id": "<practitioner id>", "displayName": "Dr. Example" },
  "validity": { "start": "2026-10-18T00:00:00Z", "expiry": "2027-10-18T00:00:00Z" },
  "requiresApproval": true
}'

# 2. No token -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4001/consents/<id>/approve -H 'content-type: application/json' -d '{}'

# 3. A practitioner's own token -> 403 (not the patient this request is for)
curl -s -X POST http://localhost:4001/consents/<id>/approve -H "Authorization: Bearer <practitioner token>" -H 'content-type: application/json' -d '{}'

# 4. The actual patient's own token -> 200, status flips to granted
curl -s -X POST http://localhost:4001/consents/<id>/approve -H "Authorization: Bearer <that patient's own token>" -H 'content-type: application/json' -d '{}'
```
