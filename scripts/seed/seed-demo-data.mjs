#!/usr/bin/env node
/**
 * Seeds realistic demo data into the local HInS Dev Medplum project and
 * the Consent Service, so the clinician app and patient portal both have
 * something to look at instead of empty states.
 *
 * Standards used, honestly scoped:
 *   - SNOMED CT and ICD-10 codes on Condition.code, LOINC on
 *     DocumentReference.type and Observation.code, UCUM on Observation
 *     value units, HL7's standard condition-clinical/ver-status systems.
 *     These are well-known, publicly documented codes (the same ones used
 *     throughout HL7's own FHIR spec examples) -- using them in demo data
 *     is NOT the same as having a licensed terminology server integrated.
 *     docs/PLATFORM_BLUEPRINT.md §03.5/§03.6 still has that as an open
 *     "not wired up yet" item -- a real deployment needs the NRCeS/C-DAC
 *     Pune SNOMED CT India affiliate license before using this terminology
 *     operationally, not just in sample data.
 *   - No RxNorm/drug codes: faking a specific RxCUI would be worse than no
 *     code at all, so MedicationRequest stays text-primary here, same as
 *     the MVP build -- an honest reflection of "not integrated yet."
 *   - Every seeded patient gets a `treatment_authorization` consent record
 *     on file (blueprint §04's HIPAA TPO concept), not just the two that
 *     had a `data_sharing`/`research` grant before. That's the actual
 *     compliance mechanism this platform has built; coding the clinical
 *     data is a data-quality improvement, not a compliance control by
 *     itself -- see this script's own README note on what this is and
 *     isn't before treating it as "compliant data."
 *
 * Meant to run ONCE against a fresh stack (docker compose up from clean
 * volumes). It is not idempotent — re-running it creates duplicate
 * patients. If you need a clean reseed, wipe the Postgres volumes and
 * start over (`npm run infra:down -- -v && npm run infra:up`), then
 * re-run the project bootstrap before this script (see
 * docs/PLATFORM_BLUEPRINT.md's Decisions log, 2026-10-15, for how the
 * HInS Dev project itself was created).
 *
 * Usage:
 *   node scripts/seed/seed-demo-data.mjs
 *
 * Env overrides (defaults match infra/docker-compose.yml):
 *   MEDPLUM_BASE_URL, CONSENT_SERVICE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';

const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
const CONSENT_SERVICE_URL = process.env.CONSENT_SERVICE_URL ?? 'http://localhost:4001';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'medplum_admin';
const MRN_SYSTEM = 'https://hins.example/identifiers/mrn';

const SNOMED = 'http://snomed.info/sct';
const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const CONDITION_CLINICAL = 'http://terminology.hl7.org/CodeSystem/condition-clinical';
const CONDITION_VER_STATUS = 'http://terminology.hl7.org/CodeSystem/condition-ver-status';
const OBSERVATION_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';

// Well-known, publicly documented codes only -- see file header. Never
// guess a code; a wrong one is worse than no code.
const CODES = {
  conditions: {
    hypertension: { snomed: { code: '38341003', display: 'Hypertensive disorder, systemic arterial' }, icd10: { code: 'I10', display: 'Essential (primary) hypertension' } },
    fever: { snomed: { code: '386661006', display: 'Fever' }, icd10: { code: 'R50.9', display: 'Fever, unspecified' } },
    anemiaSuspected: { snomed: { code: '271737000', display: 'Anemia' }, icd10: { code: 'D64.9', display: 'Anemia, unspecified' } },
    ckd: { snomed: { code: '709044004', display: 'Chronic kidney disease' }, icd10: { code: 'N18.9', display: 'Chronic kidney disease, unspecified' } },
  },
  docTypes: {
    progressNote: { loinc: { code: '11506-3', display: 'Progress note' } },
  },
  labs: {
    hemoglobin: { loinc: { code: '718-7', display: 'Hemoglobin [Mass/volume] in Blood' }, unit: 'g/dL' },
    creatinine: { loinc: { code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' }, unit: 'mg/dL' },
    potassium: { loinc: { code: '2823-3', display: 'Potassium [Moles/volume] in Serum or Plasma' }, unit: 'mmol/L' },
  },
};

function b64url(buf) {
  return buf.toString('base64url');
}

/** Email/password login against Medplum's PKCE-based /auth flow, with
 * project-membership selection if the account belongs to more than one
 * project. Mirrors what apps/web's SignInForm does under the hood. */
async function login(email, password, { selectProject } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  let resp = await fetchJson(`${MEDPLUM_BASE_URL}/auth/login`, {
    method: 'POST',
    body: { email, password, scope: 'openid offline_access', codeChallenge: challenge, codeChallengeMethod: 'S256' },
  });

  let code = resp.code;
  if (resp.memberships) {
    const membership = resp.memberships.find((m) => m.project.display === selectProject);
    if (!membership) {
      throw new Error(`No membership in project "${selectProject}" for ${email}. Found: ${resp.memberships.map((m) => m.project.display).join(', ')}`);
    }
    resp = await fetchJson(`${MEDPLUM_BASE_URL}/auth/profile`, {
      method: 'POST',
      body: { login: resp.login, profile: membership.id },
    });
    code = resp.code;
  }

  return fetchJson(`${MEDPLUM_BASE_URL}/oauth2/token`, {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, code_verifier: verifier },
  });
}

async function fetchJson(url, { method = 'GET', body, form, token } = {}) {
  const headers = {};
  let payload;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form);
  } else if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function fhir(token) {
  const base = `${MEDPLUM_BASE_URL}/fhir/R4`;
  return {
    get: (resourceType, id) => fetchJson(`${base}/${resourceType}/${id}`, { token }),
    create: (resourceType, resource) => fetchJson(`${base}/${resourceType}`, { method: 'POST', body: resource, token }),
    update: (resourceType, id, resource) => fetchJson(`${base}/${resourceType}/${id}`, { method: 'PUT', body: resource, token }),
  };
}

function mrn() {
  return randomUUID().slice(0, 8).toUpperCase();
}

async function createConsent({ type, grantorPatientId, scope, purposeCode, requesterId, requesterDisplayName, days = 30 }) {
  const start = new Date();
  const expiry = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  const res = await fetch(`${CONSENT_SERVICE_URL}/consents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type,
      grantor: { patientId: grantorPatientId },
      scope,
      purposeCode,
      requester: { id: requesterId, displayName: requesterDisplayName },
      validity: { start: start.toISOString(), expiry: expiry.toISOString() },
    }),
  });
  if (!res.ok) throw new Error(`Consent Service create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Every patient treated at St. Jones has a standing treatment-purpose
 * consent on file -- the HIPAA TPO concept from blueprint §04, and the
 * actual compliance mechanism this platform has built (as opposed to the
 * clinical coding below, which is a data-quality standard, not a
 * compliance control by itself). */
async function addTreatmentConsent(patientId, { department }) {
  await createConsent({
    type: 'treatment_authorization',
    grantorPatientId: patientId,
    scope: ['OPDRecord', 'LabReport', 'Prescription'],
    purposeCode: 'treatment',
    requesterId: `${department.toLowerCase().replace(/[^a-z]+/g, '-')}-dept-stjones`,
    requesterDisplayName: `St. Jones ${department} Dept.`,
    days: 365,
  });
}

async function main() {
  console.log('Logging in as admin...');
  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD, { selectProject: 'HInS Dev' });
  const projectId = adminToken.project.reference.split('/')[1];
  const adminPractitionerId = adminToken.profile.reference.split('/')[1];
  const F = fhir(adminToken.access_token);
  console.log(`  project ${projectId}, admin practitioner ${adminPractitionerId}`);

  console.log('Inviting Dr. Priya Sharma (Cardiology)...');
  const sharmaInvite = await fetchJson(`${MEDPLUM_BASE_URL}/admin/projects/${projectId}/invite`, {
    method: 'POST',
    token: adminToken.access_token,
    body: {
      resourceType: 'Practitioner',
      firstName: 'Priya',
      lastName: 'Sharma',
      email: 'dr.sharma@stjones.example',
      password: 'DrSharma123!',
      sendEmail: false,
    },
  });
  const sharmaId = sharmaInvite.profile.reference.split('/')[1];
  const sharmaResource = await F.get('Practitioner', sharmaId);
  await F.update('Practitioner', sharmaId, { ...sharmaResource, qualification: [{ code: { text: 'MD, Cardiology' } }] });
  console.log(`  Practitioner/${sharmaId} (dr.sharma@stjones.example / DrSharma123!)`);

  // --- Enrich the existing patient test-login account (created during the
  // MVP-verification session, docs/PLATFORM_BLUEPRINT.md Decisions log
  // 2026-10-15) so "My Records" / "My Consents" aren't empty on first
  // login. This ID is specific to that one bootstrap; if you're seeding a
  // genuinely fresh project, this lookup just fails gracefully below.
  const KNOWN_PATIENT_LOGIN_ID = process.env.PATIENT_TEST_LOGIN_ID ?? '590f0356-27a0-4ead-ada2-20f9f27987a1';
  console.log('Looking up the patient test-login account...');
  let ashaLogin;
  try {
    ashaLogin = await F.get('Patient', KNOWN_PATIENT_LOGIN_ID);
  } catch {
    console.log(`  (Patient/${KNOWN_PATIENT_LOGIN_ID} not found — skipping enrichment of the login-linked account)`);
  }

  const patients = [];

  async function registerPatient({ given, family, birthDate, gender, phone, department }) {
    const patient = await F.create('Patient', {
      resourceType: 'Patient',
      name: [{ given: [given], family }],
      birthDate,
      gender,
      telecom: phone ? [{ system: 'phone', value: phone }] : undefined,
      identifier: [{ system: MRN_SYSTEM, value: mrn() }],
    });
    patients.push({ ...patient, department });
    console.log(`  Patient/${patient.id} — ${given} ${family} (${department})`);
    await addTreatmentConsent(patient.id, { department });
    return patient;
  }

  async function addNote(patient, { setting, practitionerId, text, daysAgo = 0 }) {
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const encounter = await F.create('Encounter', {
      resourceType: 'Encounter',
      status: 'finished',
      class: setting === 'IPD'
        ? { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' }
        : { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      subject: { reference: `Patient/${patient.id}` },
      participant: [{ individual: { reference: `Practitioner/${practitionerId}` } }],
      period: { start: when.toISOString() },
    });
    await F.create('DocumentReference', {
      resourceType: 'DocumentReference',
      status: 'current',
      type: {
        coding: [{ system: LOINC, code: CODES.docTypes.progressNote.loinc.code, display: CODES.docTypes.progressNote.loinc.display }],
        text: `${setting} note`,
      },
      subject: { reference: `Patient/${patient.id}` },
      context: { encounter: [{ reference: `Encounter/${encounter.id}` }] },
      date: when.toISOString(),
      content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(text).toString('base64') } }],
    });
    return encounter;
  }

  /** condition key must exist in CODES.conditions. verification 'confirmed' | 'provisional'. */
  async function addCondition(patient, { conditionKey, encounter, verification = 'confirmed', daysAgo = 0 }) {
    const c = CODES.conditions[conditionKey];
    await F.create('Condition', {
      resourceType: 'Condition',
      clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: 'active' }] },
      verificationStatus: { coding: [{ system: CONDITION_VER_STATUS, code: verification }] },
      code: {
        coding: [
          { system: SNOMED, code: c.snomed.code, display: c.snomed.display },
          { system: ICD10, code: c.icd10.code, display: c.icd10.display },
        ],
        text: c.snomed.display,
      },
      subject: { reference: `Patient/${patient.id}` },
      encounter: encounter ? { reference: `Encounter/${encounter.id}` } : undefined,
      recordedDate: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  /** lab key must exist in CODES.labs. */
  async function addLabResult(patient, { labKey, value, encounter, daysAgo = 0 }) {
    const l = CODES.labs[labKey];
    await F.create('Observation', {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: 'laboratory', display: 'Laboratory' }] }],
      code: { coding: [{ system: LOINC, code: l.loinc.code, display: l.loinc.display }], text: l.loinc.display },
      subject: { reference: `Patient/${patient.id}` },
      encounter: encounter ? { reference: `Encounter/${encounter.id}` } : undefined,
      effectiveDateTime: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
      valueQuantity: { value, unit: l.unit, system: UCUM, code: l.unit },
    });
  }

  async function addRx(patient, { medication, dosage, practitionerId, daysAgo = 0 }) {
    // Text-primary on purpose -- see file header: no drug terminology
    // (RxNorm / India Drug Extension) integrated yet, and a fabricated
    // code would be worse than none.
    await F.create('MedicationRequest', {
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${patient.id}` },
      requester: { reference: `Practitioner/${practitionerId}` },
      medicationCodeableConcept: { text: medication },
      dosageInstruction: [{ text: dosage }],
      authoredOn: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  console.log('Registering patients...');

  if (ashaLogin) {
    patients.push({ ...ashaLogin, department: 'General Medicine' });
    console.log(`  Reusing login-linked Patient/${ashaLogin.id} — Asha Verma (General Medicine)`);
    const enc1 = await addNote(ashaLogin, {
      setting: 'OPD',
      practitionerId: adminPractitionerId,
      text: 'Chief complaint: fatigue and occasional palpitations.\nExam: BP 128/82, HR 88, regular. No acute distress.\nAssessment: likely benign palpitations, rule out anemia.\nPlan: CBC and thyroid panel, follow up in 2 weeks.',
      daysAgo: 6,
    });
    await addCondition(ashaLogin, { conditionKey: 'anemiaSuspected', encounter: enc1, verification: 'provisional', daysAgo: 6 });
    await addLabResult(ashaLogin, { labKey: 'hemoglobin', value: 11.2, encounter: enc1, daysAgo: 5 });
    await addNote(ashaLogin, {
      setting: 'OPD',
      practitionerId: sharmaId,
      text: 'Cardiology follow-up. CBC/thyroid panel unremarkable. ECG normal sinus rhythm.\nAssessment: palpitations likely stress-related.\nPlan: lifestyle counseling, reduce caffeine, return if symptoms recur.',
      daysAgo: 1,
    });
    await addRx(ashaLogin, {
      medication: 'Ferrous sulfate 325mg',
      dosage: '1 tablet daily with food for 4 weeks',
      practitionerId: adminPractitionerId,
      daysAgo: 6,
    });
    await addTreatmentConsent(ashaLogin.id, { department: 'General Medicine' });
    await createConsent({
      type: 'data_sharing',
      grantorPatientId: ashaLogin.id,
      scope: ['OPDRecord', 'LabReport'],
      purposeCode: 'treatment',
      requesterId: 'cardiology-dept-stjones',
      requesterDisplayName: 'St. Jones Cardiology Dept.',
    });
  } else {
    console.log('  (no existing login-linked Asha Verma found — skipping enrichment)');
  }

  const ramesh = await registerPatient({ given: 'Ramesh', family: 'Iyer', birthDate: '1965-03-22', gender: 'male', phone: '+91-98765-43210', department: 'Cardiology' });
  const rameshEnc = await addNote(ramesh, { setting: 'IPD', practitionerId: sharmaId, text: 'Admitted for hypertensive urgency, BP 182/110 on arrival.\nStarted on IV labetalol, responded well.\nPlan: transition to oral antihypertensives, discharge tomorrow if stable overnight.', daysAgo: 3 });
  await addCondition(ramesh, { conditionKey: 'hypertension', encounter: rameshEnc, daysAgo: 3 });
  await addRx(ramesh, { medication: 'Amlodipine 5mg', dosage: '1 tablet once daily', practitionerId: sharmaId, daysAgo: 2 });
  await addRx(ramesh, { medication: 'Losartan 50mg', dosage: '1 tablet once daily', practitionerId: sharmaId, daysAgo: 2 });

  const fatima = await registerPatient({ given: 'Fatima', family: 'Sheikh', birthDate: '1988-11-02', gender: 'female', phone: '+91-98123-45678', department: 'OB-GYN' });
  await addNote(fatima, { setting: 'OPD', practitionerId: adminPractitionerId, text: 'Routine prenatal visit, 28 weeks.\nFundal height appropriate for dates. Fetal heart rate 142 bpm.\nPlan: glucose tolerance test, continue prenatal vitamins, next visit in 2 weeks.', daysAgo: 4 });

  const arjun = await registerPatient({ given: 'Arjun', family: 'Nair', birthDate: '2015-07-19', gender: 'male', phone: '+91-99887-76655', department: 'Pediatrics' });
  const arjunEnc = await addNote(arjun, { setting: 'OPD', practitionerId: adminPractitionerId, text: 'Presented with fever (101.8F) and sore throat for 2 days.\nRapid strep test positive.\nPlan: amoxicillin course, fluids, rest, follow up if no improvement in 48h.', daysAgo: 1 });
  await addCondition(arjun, { conditionKey: 'fever', encounter: arjunEnc, daysAgo: 1 });
  await addRx(arjun, { medication: 'Amoxicillin 250mg/5mL suspension', dosage: '5mL twice daily for 10 days', practitionerId: adminPractitionerId, daysAgo: 1 });

  const grace = await registerPatient({ given: 'Grace', family: 'Thompson', birthDate: '1972-09-30', gender: 'female', phone: '+1-555-0142', department: 'Oncology' });
  await addNote(grace, { setting: 'OPD', practitionerId: adminPractitionerId, text: 'Oncology follow-up, 6 months post-treatment.\nNo new symptoms. Recent imaging shows no recurrence.\nPlan: continue surveillance, next scan in 6 months.', daysAgo: 10 });
  await createConsent({
    type: 'research',
    grantorPatientId: grace.id,
    scope: ['OPDRecord', 'Imaging'],
    purposeCode: 'research',
    requesterId: 'oncology-outcomes-study-2026',
    requesterDisplayName: 'St. Jones Oncology Outcomes Study',
    days: 180,
  });

  const suresh = await registerPatient({ given: 'Suresh', family: 'Patel', birthDate: '1955-01-15', gender: 'male', phone: '+91-98234-56789', department: 'Nephrology' });
  const sureshEnc = await addNote(suresh, { setting: 'IPD', practitionerId: adminPractitionerId, text: 'Admitted for fluid overload, creatinine 4.2 (baseline 3.8).\nStarted on dialysis, tolerated well.\nPlan: continue scheduled hemodialysis 3x/week, nephrology to follow.', daysAgo: 2 });
  await addCondition(suresh, { conditionKey: 'ckd', encounter: sureshEnc, daysAgo: 2 });
  await addLabResult(suresh, { labKey: 'creatinine', value: 4.2, encounter: sureshEnc, daysAgo: 2 });
  await addLabResult(suresh, { labKey: 'potassium', value: 5.1, encounter: sureshEnc, daysAgo: 2 });
  await addRx(suresh, { medication: 'Sevelamer 800mg', dosage: '1 tablet with meals', practitionerId: adminPractitionerId, daysAgo: 2 });

  console.log('\nDone. Summary:');
  console.log(`  Practitioners: Medplum Admin (admin@example.com), Dr. Priya Sharma (dr.sharma@stjones.example / DrSharma123!)`);
  console.log(`  Patients seeded/enriched: ${ashaLogin ? 1 : 0} existing + ${patients.length - (ashaLogin ? 1 : 0)} new = ${patients.length} total`);
  patients.forEach((p) => console.log(`    - ${p.name[0].given[0]} ${p.name[0].family} (${p.department}) — treatment consent on file`));
  console.log('\nCoded per: SNOMED CT + ICD-10 (Condition), LOINC (DocumentReference.type, Observation.code), UCUM (lab units).');
  console.log('See this file\'s header comment for exactly what that does and does not mean re: compliance/licensing.');
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
