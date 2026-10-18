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
  see below), prescriptions (`MedicationRequest`), and a consent panel
  (below)
- **Both notes and prescriptions are editable with full version
  history** — `src/components/VersionedNote.tsx` and `VersionedRx.tsx`.
  Every edit records who made it and when, visible to any clinician
  viewing the record; see "Edit history & attribution" below for how
  that's actually implemented (it isn't Medplum's `meta.author` — that
  field doesn't auto-populate and is silently stripped if you try to set
  it yourself).
- **Edits trigger role-based in-app alerts** — `src/components/NotificationBell.tsx`,
  backed by `services/audit-service`. See "Alerting on edits" below.
- **Voice dictation** (`src/components/DictateButton.tsx`) on the note
  form — dictate instead of typing, including while correcting a note.
  **Dev/demo only**, labeled as such in the UI: see "Voice-to-text" below.
- Consent panel shows the patient's **full consent history** — active,
  revoked, and expired, not just active grants — alongside the "record
  consent" action.

## Edit history & attribution

Checked directly against this running Medplum instance before building
anything: `meta.author` is **not** set automatically on writes, and a
client-supplied `meta.author` is silently discarded (`meta` is
server-controlled). What Medplum *does* track correctly, confirmed the
same way: full version history (`GET .../_history`) with a correct
`meta.versionId`/`meta.lastUpdated` per version.

So attribution lives in a normal, non-`meta` field that persists like any
other data and is preserved per-version in history — not from anything
Medplum infers on its own:
- `DocumentReference.author` for notes — an actual standard FHIR field.
- For `MedicationRequest`, there's no equivalently-shaped standard field
  (`requester` means "who ordered this," a different fact from "who last
  corrected a typo in it" — conflating them would lose the original
  prescriber of record). Uses a custom extension instead,
  `https://hins.example/fhir/StructureDefinition/last-modified-by` —
  verified directly, the same way, that a custom extension isn't
  server-stripped the way `meta.author` is.

History is shown to clinicians only, not surfaced in the patient portal —
a UX choice (audit trails are normally clinician/admin-facing), not a
technical limit.

## Alerting on edits

Every save in `VersionedNote`/`VersionedRx` calls
`services/audit-service`'s `POST /events`, which fans out in-app
notifications to two kinds of recipient (full detail in that service's
README):
1. **Role subscribers** — admin/compliance-equivalent roles, seeded by
   `scripts/seed/`.
2. **The original author**, if someone else made the edit.

The bell in the clinician header polls for unread alerts every 20
seconds. **In-app only** — no email/SMS/pager integration, a real gap
for actual clinical alerting, not something to mistake for finished.

## Voice-to-text

**Dev/demo only — not the compliant production path**, labeled as such
in the UI next to the dictate button. It uses the browser's native
`SpeechRecognition` API, which in Chrome sends audio to Google's cloud
speech service — not self-hosted. That's a direct contradiction of
blueprint §08's own design (self-hosted Whisper by default; cloud ASR
opt-in only, gated on a BAA). No self-hosted Whisper is running in this
environment, so this is what's real and demonstrable today; swapping it
for a self-hosted engine behind the AI Gateway is open work (§16).

What *is* built faithfully to §08.1: no microphone access without a
logged consent event first. Clicking dictate auto-creates a short-lived
`recording`-type consent via the Consent Service if the patient doesn't
already have one active — a simplification of "the clinician verbally
confirms with the patient," not a captured e-signature, same honesty
standard as every other simplification in this codebase.

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
login, a compliance/security officer login, role-based alert
subscriptions, and coded diagnoses/labs for several patients, so neither
app opens empty. Run it once after `infra:up` (needs `consent-service`
and `audit-service` running too — see the repo root README).

### Test accounts (local dev project only)

| Role | Email | Password |
|---|---|---|
| Clinician (seeded by Medplum itself) | `admin@example.com` | `medplum_admin` |
| Clinician — Dr. Priya Sharma, Cardiology (`seed:demo`) | `dr.sharma@stjones.example` | `DrSharma123!` |
| Compliance & Security — Alex Fernandes (`seed:demo`) | `security@stjones.example` | `SecurityTest123!` |
| Patient — Asha Verma (`seed:demo` enriches this account) | `asha.verma.patient@example.com` | `PatientTest123!` |

All plaintext dev-only credentials for the local `HInS Dev` Medplum
project — never reuse them anywhere reachable outside this machine.

Verified end to end in a real browser (Playwright): sign in as clinician →
register a patient → add a note → create a prescription → record consent;
and separately, sign in as patient → view records → grant a new consent →
revoke it. Zero console errors in either run.
