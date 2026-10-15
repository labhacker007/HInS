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
  blueprint §08.2), **diagnoses** and **labs** (read-only, coded —
  see below), prescriptions (`MedicationRequest`), and a "record consent"
  action

**Patient (`src/pages/patient/`)**
- My Records — read-only view of own notes, diagnoses, labs, and
  prescriptions
- My Consents — every active consent grant, revocable in one click, plus a
  form to grant a new one (blueprint §04.5's "visible and revocable in one
  action")

**Clinical coding (`src/components/ClinicalCoding.tsx`, shared by both):**
diagnoses display with their **SNOMED CT** and **ICD-10** codes, lab
results with **LOINC** codes and **UCUM** units — blueprint §03.6's
"coded, not free-text, wherever a terminology exists." Read-only displays
of `Condition`/`Observation` resources; there's no "add diagnosis"/"add
lab result" form yet, only what `scripts/seed/` populates. See that
script's README for exactly what this coding does and doesn't mean re:
compliance/licensing — it's not the same as a licensed terminology server
being integrated.

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

### Demo data

```bash
npm run seed:demo    # from the repo root — see scripts/seed/README.md
```

Populates a roster of patients across departments, a second clinician
login, and coded diagnoses/labs for several of them, so neither app opens
empty. Run it once after `infra:up`.

### Test accounts (local dev project only)

| Role | Email | Password |
|---|---|---|
| Clinician (seeded by Medplum itself) | `admin@example.com` | `medplum_admin` |
| Clinician — Dr. Priya Sharma, Cardiology (`seed:demo`) | `dr.sharma@stjones.example` | `DrSharma123!` |
| Patient — Asha Verma (`seed:demo` enriches this account) | `asha.verma.patient@example.com` | `PatientTest123!` |

All plaintext dev-only credentials for the local `HInS Dev` Medplum
project — never reuse them anywhere reachable outside this machine.

Verified end to end in a real browser (Playwright): sign in as clinician →
register a patient → add a note → create a prescription → record consent;
and separately, sign in as patient → view records → grant a new consent →
revoke it. Zero console errors in either run.
