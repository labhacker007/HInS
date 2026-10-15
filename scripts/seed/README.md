# Demo data seeding

```bash
npm run seed:demo
```

Seeds the HInS Dev Medplum project and the Consent Service with a small
roster of patients, a second clinician, and coded clinical data, so the
clinician app and patient portal both have something to look at.

## What it creates

- **Dr. Priya Sharma** (Cardiology) — a second practitioner login, so you
  can demo as a named clinician instead of only "Medplum Admin"
  (`dr.sharma@stjones.example` / `DrSharma123!`).
- Six patients across St. Jones's departments (Cardiology, OB-GYN,
  Pediatrics, Oncology, Nephrology, General Medicine), each with:
  - A standing `treatment_authorization` consent on file (every patient
    treated at a hospital has one — see below).
  - At least one OPD or inpatient encounter note.
- For several patients: a coded `Condition` (diagnosis), coded lab
  `Observation`s, and a `MedicationRequest`.
- Enriches the patient test-login account from the MVP session
  (`asha.verma.patient@example.com`) specifically, so logging in as a
  patient shows real data, not an empty portal.

## Standards used, and what that does and doesn't mean

Conditions are coded with **SNOMED CT and ICD-10**, document types and lab
results with **LOINC**, lab values with **UCUM** units — all well-known,
publicly documented codes (the same ones used throughout HL7's own FHIR
spec examples). This is real coded data, not placeholder text.

It is **not** the same as having a licensed terminology server integrated.
`docs/PLATFORM_BLUEPRINT.md` §03.5/§03.6 still lists that as an open,
"not wired up yet" item — a real deployment needs the NRCeS/C-DAC Pune
SNOMED CT India affiliate license before using this terminology
operationally, not just in a handful of demo codes.

Medications are deliberately **not** coded (no RxNorm/India Drug
Extension integrated yet) — a fabricated drug code would be a worse bug
than an honest text field.

**On "DPDP/HIPAA compliant":** giving every seeded patient a consent
record on file reflects the one compliance mechanism this platform has
actually built (§04's Consent Service). It is not, by itself, what makes
a system DPDP- or HIPAA-compliant — that also needs the encryption, access
control enforcement, breach-notification workflows, and legal review
that §03, §09, and §16 of the blueprint already track as open work. Don't
read "the demo data is coded and has consent records" as "the platform is
compliant."

## Notes

- **Not idempotent.** Re-running creates duplicate patients. For a clean
  reseed, wipe the Postgres volumes (`npm run infra:down -- -v`) and
  bring the stack back up before re-running.
- Needs `infra:up` and the Consent Service (`npm run dev:consent-service`)
  both running first.
- All test accounts and their passwords are listed in
  `apps/web/README.md`.
