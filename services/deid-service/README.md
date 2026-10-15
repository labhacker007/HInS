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
- The `disclosure_audit_log` and `pseudonym_mapping` tables are
  unauthenticated in this dev build (`GET /audit` has no access control).
  Both tables hold real patient IDs and are themselves sensitive — a real
  deployment restricts them to the `compliance_officer` role (blueprint
  §10.1) before this goes anywhere near real data.
- Medplum access for this service reuses the admin dev login, not a
  proper `client_credentials` service identity — see `src/medplumClient.ts`'s
  header for why, and §16 of the blueprint for the open item.

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
```
