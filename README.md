# HInS — Health Integrated System

**An open, FHIR-native hospital platform: EHR, EMR and Hospital Information System in one, built for India (DPDP Act, ABDM/ABHA) and the US (HIPAA).**

One shared patient record, department-scoped access enforced by the server, data that flows between departments through orders and referrals — and self-hosted AI dictation so patient audio never leaves your infrastructure.

![Patient chart — vitals with LOINC codes and trends](docs/screenshots/03-chart-vitals.png)

> **Status: working prototype, not production-certified.** Everything listed below runs and is verified end to end against a live stack, but HInS has not had a clinical safety, legal or security audit. Do not use it with real patient data yet — see [Known gaps](#known-gaps).

---

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Demo logins](#demo-logins)
- [Architecture](#architecture)
- [Compliance design](#compliance-design)
- [Known gaps](#known-gaps)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)

---

## What it does

### Clinical records (EHR / EMR)
- **Patient registration & demographics** — names, contact, full Indian address, emergency contact, occupation, blood group, **ABHA number and ABHA address** (format-validated; identifier system from the NRCeS ABDM FHIR IG).
- **Structured consult notes (SOAP)** with **voice dictation on every section**, saved as FHIR `DocumentReference` linked to the encounter.
- **Coded diagnoses** — SNOMED CT search with ICD-10 mapping, stored as FHIR `Condition`.
- **Vitals** — BP, HR, RR, temperature, SpO₂, weight, height, auto-computed BMI, all LOINC/UCUM coded, with a trend table.
- **Allergies & intolerances**, **social history** (smoking, alcohol, activity), **diet preference** (vegetarian, eggetarian, Jain, vegan…).
- **Prescriptions** with full edit history, plus **pharmacy dispensing and medication administration**.
- **Every edit versioned**, with who changed what and when visible to clinicians, and role-based alerts when records are corrected.

### Hospital operations (HIS)
- **11 departments**, from Emergency, OPD, Cardiology and Pediatrics through Laboratory, Radiology, Pharmacy, Nutrition and Billing to Administration.
- **Triage queue** — chief complaint, vitals, pain score, acuity 1–5, sorted by urgency.
- **Inter-department referrals** with a per-department inbox (accept → complete).
- **Lab & radiology** — orders routed to the right department, work queues, results uploaded as **PDF/images, FHIR JSON, HL7 v2 ORU^R01, or DICOM**, and **pathologist / radiologist sign-off** (preliminary → final → amended).
- **Bed & ward management** — admit, transfer, discharge with a live census.
- **Appointment scheduling** with double-booking detection.
- **Billing & RCM** — coverage, charges, claims, invoices and payment recording.
- **Dietitian diet orders** (diabetic, low-salt, renal, soft…).
- **Staff administration** — invite staff, assign department + role, deactivate; every role gets a server-enforced access policy.

### Patient portal
- Patients see their own records, appointments and **every consent they have given — active, pending, revoked or expired** — and can approve, deny or revoke in one click.

### Privacy & AI
- **Consent management** for DPDP / HIPAA / ABDM purposes, append-only ledger, patient approval round-trip.
- **De-identification service** for research and admin export — HIPAA Safe Harbor, Limited Data Set, or GDPR-style pseudonymization.
- **Self-hosted speech-to-text** (Whisper via [speaches](https://github.com/speaches-ai/speaches), MIT) on every clinical free-text field. Audio stays on your servers; voice activity detection suppresses Whisper's known habit of inventing text during silence; low-confidence segments are flagged; nothing is saved without clinician review.

---

## Screenshots

| | |
|---|---|
| ![Sign in](docs/screenshots/01-sign-in.png) **Sign in** | ![Patient list](docs/screenshots/02-patient-list.png) **Patient list** |
| ![Consult note](docs/screenshots/04-chart-consult-note.png) **SOAP consult note with dictation** | ![Demographics and ABHA](docs/screenshots/05-chart-demographics-abha.png) **Demographics & ABHA** |
| ![Allergies](docs/screenshots/06-chart-allergies.png) **Allergies** | ![Social history and diet](docs/screenshots/07-chart-social-diet.png) **Social history, diet & diet orders** |
| ![Diagnostic reports](docs/screenshots/08-chart-diagnostic-reports.png) **Signed lab report (HL7 v2 import)** | ![Referrals](docs/screenshots/09-chart-referrals.png) **Referrals from the chart** |
| ![Triage queue](docs/screenshots/11-triage-queue.png) **Triage queue by acuity** | ![Referral inbox](docs/screenshots/18-referral-inbox.png) **Department referral inbox** |
| ![Lab queue](docs/screenshots/12-lab-queue.png) **Laboratory work queue** | ![Radiology queue](docs/screenshots/13-radiology-queue.png) **Radiology work queue** |
| ![Bed board](docs/screenshots/14-bed-board.png) **Bed & ward census** | ![Scheduling](docs/screenshots/15-scheduling.png) **Scheduling** |
| ![Billing](docs/screenshots/16-billing.png) **Billing & claims** | ![Staff admin](docs/screenshots/17-staff-admin.png) **Staff & role administration** |
| ![Consent](docs/screenshots/10-chart-consent.png) **Consent history (clinician view)** | ![Patient portal consents](docs/screenshots/20-patient-portal-consents.png) **Patient portal — my consents** |

---

## Quick start

**Prerequisites:** Docker Desktop (running), Node.js 22 (`nvm install` reads `.nvmrc`), ~8 GB free RAM. First run downloads several images and a speech model, so allow a few minutes.

```bash
git clone https://github.com/labhacker007/HInS.git
cd HInS
npm run up
```

`npm run up` does everything: installs dependencies, starts the infrastructure (Medplum FHIR server and app, Keycloak, two Postgres instances, Redis) and the speech-to-text server, then runs `npm run bootstrap`. Bootstrap creates the HInS project, the web app's sign-in client and the database schema, and seeds departments, roles, staff, demo patients and showcase activity. Finally it builds and starts the app containers. It is safe to re-run: existing data is detected and reused, never duplicated.

One manual step on first run: download the speech model (about 500 MB):

```bash
curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-small.en
```

Then open **http://localhost:3080** and sign in with a [demo login](#demo-logins).

| Service | URL |
|---|---|
| HInS web app (containerised) | http://localhost:3080 |
| Medplum FHIR API | http://localhost:8103 |
| Medplum admin console | http://localhost:3000 |
| Keycloak (role source) | http://localhost:8080 (`admin` / `admin`) |
| Speech-to-text (Whisper) | http://localhost:8000 |
| consent / deid / audit services | :4001 / :4003 / :4005 |

**Developing instead?** Run `npm run dev -w apps/web` for hot reload on http://localhost:5173.

**Check it works:** `node scripts/seed/verify-access-policies.mjs` (54 server-side permission checks) and `node scripts/verify/verify-cross-department.mjs` (order → lab → pathologist → physician, with billing denied).

---

## Demo logins

> These accounts are for a **local demo stack only** — change every password before exposing the system anywhere.

**One login to see everything:** `admin@example.com` / `medplum_admin` opens every clinician module plus Staff administration.

| Role | Department | Email | Password | Sees |
|---|---|---|---|---|
| Super admin | — | `admin@example.com` | `medplum_admin` | Everything |
| Hospital admin | Administration | `hospital.admin@stjones.example` | `Staff123!` | Everything incl. staff management |
| Physician | Cardiology | `dr.sharma@stjones.example` | `DrSharma123!` | Full clinical chart |
| Triage nurse | Emergency | `triage.nurse@stjones.example` | `Staff123!` | Registration, vitals, triage |
| Lab technician | Laboratory | `lab.tech@stjones.example` | `Staff123!` | Lab orders & results only — no clinical notes |
| Pathologist | Laboratory | `pathologist@stjones.example` | `Staff123!` | Lab results + report sign-off |
| Radiologist | Radiology | `radiologist@stjones.example` | `Staff123!` | Imaging orders, studies, report sign-off |
| Pharmacist | Pharmacy | `pharmacist@stjones.example` | `Staff123!` | Prescriptions & allergies; dispensing |
| Dietitian | Nutrition | `dietitian@stjones.example` | `Staff123!` | Diet orders, allergies, vital signs only |
| Billing staff | Billing | `billing@stjones.example` | `Staff123!` | Financial records; **blocked** from clinical data |
| Compliance officer | — | `security@stjones.example` | `SecurityTest123!` | Audit & edit alerts |
| Patient (Asha Verma) | — | `asha.verma.patient@example.com` | `PatientTest123!` | Patient portal |

Try the same patient as different roles to see department segregation: the billing login gets **HTTP 403** from the server on clinical notes, not just a hidden button.

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    WEB[HInS web app<br/>React · Mantine · @medplum/react]
  end
  subgraph Core
    MED[(Medplum FHIR R4 server<br/>+ AccessPolicies)]
    PG1[(Postgres 18<br/>clinical data)]
  end
  subgraph HInS services
    CON[consent-service]
    DEID[deid-service]
    AUD[audit-service]
    PG2[(Postgres 18 + pgvector)]
  end
  KC[Keycloak<br/>role source]
  ASR[Whisper / speaches<br/>self-hosted ASR]
  WEB -->|FHIR, role-scoped| MED --> PG1
  WEB --> CON & AUD
  WEB -->|audio stays local| ASR
  CON & DEID & AUD --> PG2
  DEID & AUD -->|role lookup| KC
  DEID --> MED
```

- **Medplum** (Apache-2.0) is the clinical core: a full FHIR R4 server whose AccessPolicies enforce each role's permissions on every request.
- **HInS services** (Node 22 · Fastify · Zod · Drizzle) add what no EHR provides: the consent ledger, de-identification, and the edit audit trail with alerting.
- **Everything is a standard FHIR resource** — `Encounter`, `Condition`, `Observation`, `ServiceRequest`, `DiagnosticReport`, `ImagingStudy`, `NutritionOrder`, `Claim`… — so data is portable and interoperable by design.

---

## Compliance design

| Requirement | How HInS addresses it |
|---|---|
| HIPAA minimum-necessary · DPDP purpose limitation | One record, role- and department-scoped access enforced server-side; cross-department flow only via orders/referrals |
| DPDP consent (Sec. 6) · ABDM consent artefacts | Append-only consent ledger, patient approval round-trip, revoke anytime, full history visible to patient and clinician |
| Audit trail | Every clinical edit versioned with author and timestamp; alerts to authors and compliance roles |
| Research & secondary use | De-identification service: Safe Harbor, Limited Data Set, pseudonymization — every disclosure logged |
| Data residency for AI | Speech-to-text self-hosted; no patient audio sent to third-party APIs |
| Interoperability | FHIR R4 throughout; SNOMED CT, LOINC, ICD-10, UCUM codes; HL7 v2 and DICOM import |

The full framework — DPDP, ABDM, ICMR, HIPAA, Section 1557, 42 CFR Part 2, FDA SaMD boundary — is in the [platform blueprint](docs/PLATFORM_BLUEPRINT.md). **None of it is legal advice.**

---

## Known gaps

Stated plainly, as everywhere in this codebase:

- **Not production-ready.** No clinical safety case, security audit or legal review yet. No named HIPAA Security/Privacy Officer.
- **ABHA verification** with ABDM needs sandbox credentials from [sandbox.abdm.gov.in](https://sandbox.abdm.gov.in) — the button is disabled, not faked. Real ABDM data exchange (HIP/HIU, FHIR IG bundles) is not built.
- **SNOMED CT** is a verified 108-concept starter set; full use needs India's free SNOMED affiliate licence (MLDS via NRCeS) plus a terminology server (Snowstorm, Apache-2.0). Medications are free text, so **no drug-interaction checking** yet.
- **Speech-to-text accuracy on real clinical audio is unvalidated.** The default model is small enough to run on a laptop CPU; production should use a larger model on a GPU, benchmarked on real (consented) Indian-English dictation. See the [model research](docs/research/clinical-ai-models.md).
- **DICOM** files upload and are stored, but there's no in-browser viewer yet (OHIF, MIT, is planned).
- Access is scoped **by role**, not yet by department within a role (a lab tech sees all lab orders hospital-wide).
- Real payer/clearinghouse claim submission, NHCX (India), inventory, and full LIS/RIS-PACS integration are not built.

---

## Repository layout

```
apps/web/                 React web app — clinician app, admin and patient portal
services/consent-service/ Consent ledger (DPDP / HIPAA / ABDM purposes)
services/deid-service/    De-identification & research export
services/audit-service/   Edit audit trail and role-based alerting
packages/shared/          Shared TypeScript types
infra/                    docker-compose: infrastructure, app containers, speech-to-text
scripts/seed/             Departments, roles & access policies, staff, demo and showcase data
scripts/verify/           End-to-end verification scripts
docs/                     Platform blueprint, research, screenshots
```

## Documentation

- [**Platform blueprint**](docs/PLATFORM_BLUEPRINT.md) — architecture, compliance framework, roadmap, every decision with its rationale.
- [**Clinical AI model research**](docs/research/clinical-ai-models.md) — licence-checked survey of open speech-to-text, OCR and clinical NLP models.
- [`apps/web/README.md`](apps/web/README.md) and each `services/*/README.md` — module details and what each does and doesn't mean for compliance.

## Open-source foundations

HInS builds on permissively licensed projects and copies no copyleft code: [Medplum](https://github.com/medplum/medplum) (Apache-2.0), [Keycloak](https://www.keycloak.org) (Apache-2.0), [speaches](https://github.com/speaches-ai/speaches) and [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT), [Mantine](https://mantine.dev) (MIT), [Fastify](https://fastify.dev) (MIT), [Drizzle](https://orm.drizzle.team) (Apache-2.0), PostgreSQL and pgvector.

## License

No licence has been chosen for HInS itself yet, so all rights are reserved by default. Open an issue if you'd like to use it.
