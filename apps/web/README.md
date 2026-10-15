# apps/web — clinician/doctor and patient web app

Phase 01 MVP (blueprint §13) — a single Vite + React + `@medplum/react`
app, split by role (blueprint §10): signing in as a **Practitioner**
renders the clinician app, signing in as a **Patient** renders the patient
portal. Which one you see is driven entirely by the FHIR `resourceType` of
your profile in the HInS Dev project — not a separate flag.

## What's built

**Clinician (`src/pages/clinician/`)**
- Patient list with name search, and registration of new patients
- Patient detail: encounter notes (OPD/clinic or inpatient setting, per
  blueprint §08.2), prescriptions (`MedicationRequest`), and a "record
  consent" action

**Patient (`src/pages/patient/`)**
- My Records — read-only view of own notes and prescriptions
- My Consents — every active consent grant, revocable in one click, plus a
  form to grant a new one (blueprint §04.5's "visible and revocable in one
  action")

Both talk to the real running Medplum instance (`infra/docker-compose.yml`)
over its FHIR API via `@medplum/core`, and to `services/consent-service`
for everything consent-related — nothing here is mocked.

**Simplification, stated where it matters (also noted in-app):** the
"record consent" / "grant consent" actions write a grant directly. A real
ABDM flow routes that through the patient's own consent-manager app for
approval first (§04.2) — that round trip isn't built yet (§16 open
decisions).

## Running it

Needs the infra stack and consent-service up (see the repo root README).
Then:

```bash
npm install                 # from the repo root
npm run dev -w apps/web     # http://localhost:5173
```

`.env.local` holds the Medplum client ID this app authenticates with — see
`.env.example` for the shape. The client app itself is registered in
Medplum as `ClientApplication` `HInS Web (local dev)`.

### Test accounts (local dev project only)

| Role | Email | Password |
|---|---|---|
| Clinician (seeded by Medplum itself) | `admin@example.com` | `medplum_admin` |
| Patient (invited for testing) | `asha.verma.patient@example.com` | `PatientTest123!` |

Both are plaintext dev-only credentials for the local `HInS Dev` Medplum
project — never reuse them anywhere reachable outside this machine.

Verified end to end in a real browser (Playwright): sign in as clinician →
register a patient → add a note → create a prescription → record consent;
and separately, sign in as patient → view records → grant a new consent →
revoke it. Zero console errors in either run.
