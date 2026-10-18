# deid-service — de-identification / data exposure

docs/PLATFORM_BLUEPRINT.md §11's "Data Exposure Policy" and
de-identification pipeline, actually built. Sits between any research or
admin consumer and the live clinical data in Medplum — nothing reaches a
caller without going through `src/deidentify.ts` first.

## Three methods, not one "anonymize" toggle

| Method | Standard | Reversible? | Dates | Geography | Consent gate |
|---|---|---|---|---|---|
| `safe_harbor` | HIPAA Safe Harbor, 45 CFR 164.514(b)(2) | No — random pseudonym, nothing stored | Year only; suppressed entirely at age ≥90 | None retained | Requires an active `research`-purpose consent (blueprint §04) when `purpose=research` |
| `limited_dataset` | HIPAA Limited Data Set, 45 CFR 164.514(e) | No — random pseudonym, nothing stored | Full precision | City/state/postal code (street stripped) | None (HIPAA permits this under a Data Use Agreement — not modeled here) |
| `pseudonymized` | GDPR Art. 4(5) / Recital 26 | **Yes** — via `pseudonym_mapping`, see `POST /reidentify` | Full precision | None retained | None — for internal/admin use |

Every method strips name, telecom, identifiers (MRN/SSN-like), and
photos. Every method drops the raw `encounter` reference and `meta`
block (data minimization, not because either was found to leak an
identifier).

**Not implemented, on purpose:** scrubbing identifiers out of free-text
clinical notes. `DocumentReference` is excluded from every export
entirely rather than partially scrubbed — a validated NLP de-identifier
(Presidio + clinical NER, per blueprint §07/§08) isn't wired up yet, and
a naive regex pass would miss real identifiers while looking safe. See
`src/deidentify.ts`'s file header for the full reasoning.

## What "DPDP/HIPAA/GDPR compliant" does and doesn't mean here

This implements the **technical transformation** each named standard
describes, correctly, and verified against real seeded data. It does
**not** by itself make the platform compliant:

- No legal review of this classification scheme has happened (blueprint
  §03's standing "not legal advice" disclaimer applies here too).
- `limited_dataset` real-world use requires a signed Data Use Agreement
  with the recipient — this service has no DUA concept.
- GDPR's "anonymous data" test is "means reasonably likely to be used" to
  re-identify, not a fixed checklist — `safe_harbor`'s HIPAA-defined
  method is a reasonable technical basis for that but isn't itself a GDPR
  legal determination.
- **`GET /audit` is now access-controlled, closing the gap this README
  used to state plainly (2026-10-15 → 2026-10-18 update):** the caller
  must send a real `Authorization: Bearer <token>` for an authenticated
  Medplum user on this project (verified live against Medplum's own
  `GET /auth/me` — not a locally-decoded JWT, see `src/index.ts`'s
  `resolveCaller` header comment for why a naive "forward the token to
  `GET /fhir/R4/Practitioner/{claimedId}`" check was tried first and
  found spoofable on this instance), AND that caller must have an active
  `alert_subscriptions` row (audit-service's table, reused directly —
  see that service's README) with role `tenant_admin` or
  `compliance_officer`. No token → 401; wrong role → 403 naming the
  roles required. Both tables still hold real patient IDs and are still
  sensitive; this closes the *access-control* gap, not the data-
  sensitivity design, which is unchanged.
- **What's still NOT real RBAC, said plainly rather than implied fixed:**
  the role source of truth is still the hand-seeded `alert_subscriptions`
  table (audit-service's), not a Keycloak-integrated role system —
  anyone with direct Postgres access or a compromised admin session can
  still grant themselves/anyone an admin role by inserting a row. Token
  validation happens via a live call to Medplum's `/auth/me` on *every*
  request rather than local JWT/JWKS verification — correct today, but
  slower than it needs to be; a legitimate follow-up, not hidden. Full
  Keycloak/RBAC integration is still the bigger open item (blueprint
  §16).
- **Medplum access for this service's own calls to Medplum (export/
  reidentify) now uses a real `client_credentials` grant, not the admin
  dev login (2026-10-18 update):** re-checked directly against this
  instance rather than assuming the earlier attempt's finding still
  held — `GET /fhir/R4/ClientApplication/:id` with an admin bearer token
  *does* return the `secret` field, so this service authenticates as the
  project's own `ClientApplication` (a real non-human service identity)
  rather than the admin's email+password. See `src/medplumClient.ts`'s
  header. (This is separate from the caller-authentication work above:
  that's about who's allowed to call *this* service's endpoints; this is
  about how *this service* authenticates to Medplum to do its own work.)

## API

```
POST /export
  { patientIds: string[], method, purpose, requesterId, requesterDisplayName,
    includeResourceTypes?: ('Condition'|'Observation'|'MedicationRequest'|'Encounter')[] }
  -> { method, exportedAt, patients: [{ pseudonymId, resources }], skipped: [{ patientId, reason }] }

POST /reidentify
  { pseudonymId, requesterId, requesterDisplayName, justification }
  -> { realPatientId }                      (404 if not a pseudonymized-method pseudonym)

GET /audit?limit=50
  Requires Authorization: Bearer <Medplum access token> for a caller
  whose Practitioner has an active alert_subscriptions role of
  tenant_admin or compliance_officer. 401 (no/invalid token) or
  403 (valid token, wrong role) otherwise.
  -> disclosure_audit_log rows, newest first
```

## Try it (needs infra + consent-service + seed:demo already run)

```bash
npm run dev -w services/deid-service   # :4003
```

```bash
curl -X POST localhost:4003/export -H 'content-type: application/json' -d '{
  "patientIds": ["<a patient id without a research consent>"],
  "method": "safe_harbor",
  "purpose": "research",
  "requesterId": "researcher-1",
  "requesterDisplayName": "Dr. Researcher"
}'
# -> "skipped", with the no-consent reason stated

# GET /audit needs a real Medplum bearer token for an admin/compliance
# practitioner — get one the same way apps/web's login does (password +
# PKCE device flow against :8103), e.g. admin@example.com / medplum_admin:
curl localhost:4003/audit -H "Authorization: Bearer <token>"
# -> 401 with no token; 403 if the token's practitioner has no
#    alert_subscriptions row with role tenant_admin/compliance_officer.
```
