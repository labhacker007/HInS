/**
 * Showcase demo data — realistic, cross-department activity created by the
 * app's OWN library code (apps/web/src/lib/*), each step run as the real
 * role login that would do it in the hospital, so server-side AccessPolicies
 * are exercised too. Idempotent via a meta.tag sentinel.
 *
 * Run: npm run seed:showcase   (bundles this file with esbuild, then runs it)
 * Needs: seed-demo-data, seed-departments, seed-access-policies, seed-staff.
 */
import { MedplumClient } from '@medplum/core';
import type { Encounter, Patient, Reference } from '@medplum/fhirtypes';
// @ts-expect-error -- plain .mjs helper shared with the other seed scripts
import { login, adminLogin, PROJECT_ID, MEDPLUM_BASE_URL } from '../_medplum-client.mjs';
import { buildTriageEncounter, buildTriageObservations, buildDiagnosisCondition, buildConsultDocumentReference, buildReferral } from '../../../apps/web/src/lib/clinical';
import { buildVitalsObservations, buildAllergy, buildLifestyleObservation, buildNutritionOrder, LIFESTYLE_ITEMS } from '../../../apps/web/src/lib/patientProfile';
import { createOrder, importHl7Oru, signOffReport, findDepartment } from '../../../apps/web/src/lib/diagnostics';
import { search } from '../../../apps/web/src/lib/terminology';

const SENTINEL = { system: 'https://hins.example/fhir/showcase', code: 'v1' };

async function client(email: string | null, password?: string): Promise<MedplumClient> {
  const m = new MedplumClient({ baseUrl: MEDPLUM_BASE_URL, fetch });
  m.setAccessToken(email ? await login(email, password, PROJECT_ID) : await adminLogin());
  return m;
}
const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const term = (q: string) => {
  const t = search(q, 1)[0];
  if (!t) throw new Error(`No starter-terminology entry for "${q}"`);
  return t;
};

const admin = await client(null);
const tagged = await admin.searchResources('Encounter', { _tag: `${SENTINEL.system}|${SENTINEL.code}`, _count: 50 });

const findPatient = async (family: string, given: string): Promise<Patient> => {
  const list = await admin.searchResources('Patient', { family, given, _count: 5 });
  if (!list[0]) throw new Error(`Seed patient ${given} ${family} not found — run seed:demo first`);
  return list[0];
};
const asha = await admin.readResource('Patient', '590f0356-27a0-4ead-ada2-20f9f27987a1');
const ramesh = await findPatient('Iyer', 'Ramesh');
const fatima = await findPatient('Sheikh', 'Fatima');
const arjun = await findPatient('Nair', 'Arjun');
const pref = (p: Patient): Reference => ({ reference: `Patient/${p.id}`, display: `${p.name?.[0]?.given?.[0]} ${p.name?.[0]?.family}` });

const nurse = await client('triage.nurse@stjones.example', 'Staff123!');
const doc = await client('dr.sharma@stjones.example', 'DrSharma123!');
const lab = await client('lab.tech@stjones.example', 'Staff123!');
const patho = await client('pathologist@stjones.example', 'Staff123!');
const diet = await client('dietitian@stjones.example', 'Staff123!');
const me = async (m: MedplumClient): Promise<Reference> => {
  const p = (await m.get('auth/me')).profile;
  return { reference: `Practitioner/${p.id}`, display: `${p.name?.[0]?.given?.[0] ?? ''} ${p.name?.[0]?.family ?? ''}`.trim() };
};
const nurseRef = await me(nurse);
const docRef = await me(doc);

// 1. Emergency/OPD triage queue — triage nurse.
const emergency = await findDepartment(admin, 'emergency');
const opd = await findDepartment(admin, 'general-medicine');
const triage = [
  { p: ramesh, dept: emergency, code: 'emergency', cc: 'Crushing chest pain radiating to left arm, 40 min', acuity: 2, hrs: 0.6, v: { systolic: 158, diastolic: 96, heartRate: 112, respRate: 22, temperature: 37.1, spo2: 94 }, pain: 8 },
  { p: fatima, dept: opd, code: 'general-medicine', cc: 'Fever and productive cough, 3 days', acuity: 3, hrs: 1.2, v: { systolic: 122, diastolic: 78, heartRate: 98, respRate: 20, temperature: 38.6, spo2: 96 }, pain: 3 },
  { p: arjun, dept: opd, code: 'general-medicine', cc: 'Sprained right ankle while playing football', acuity: 4, hrs: 0.4, v: { systolic: 118, diastolic: 74, heartRate: 84, respRate: 16, temperature: 36.8, spo2: 99 }, pain: 5 },
];
let ashaEncounter: Encounter | undefined = tagged.find((e) => e.class?.code === 'AMB');
const triageDone = tagged.some((e) => e.status === 'triaged');
if (triageDone) console.log('triage: already seeded, skipping');
for (const t of triageDone ? [] : triage) {
  const enc = buildTriageEncounter({
    patient: pref(t.p), department: { reference: `Organization/${t.dept.id}`, display: t.dept.name }, departmentCode: t.code,
    arrival: ago(t.hrs), chiefComplaint: t.cc, acuity: t.acuity, triagedBy: nurseRef,
  });
  enc.meta = { tag: [SENTINEL] };
  const saved = await nurse.createResource(enc);
  for (const o of buildTriageObservations({ patient: pref(t.p), encounter: { reference: `Encounter/${saved.id}` }, performer: nurseRef, effective: ago(t.hrs), vitals: t.v, pain: t.pain, acuity: t.acuity })) {
    await nurse.createResource(o);
  }
  console.log(`triage: ${t.p.name?.[0]?.given?.[0]} acuity ${t.acuity}`);
}

// 2. Asha Verma — an OPD visit with full chart.
const chartDone = Boolean(ashaEncounter);
if (chartDone) console.log('chart: already seeded, skipping');
if (!ashaEncounter) ashaEncounter = await doc.createResource<Encounter>({
  resourceType: 'Encounter', status: 'in-progress', meta: { tag: [SENTINEL] },
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
  subject: pref(asha), participant: [{ individual: docRef }], period: { start: ago(2) },
});
const encRef = { reference: `Encounter/${ashaEncounter.id}` };
const conds = chartDone ? await admin.searchResources('Condition', { subject: `Patient/${asha.id}`, _count: 50 }) : [];
if (!chartDone) {
for (const [h, v] of [[24 * 60, { systolic: 128, diastolic: 84, heartRate: 78, respRate: 16, tempC: 36.7, spo2: 98, weightKg: 68, heightCm: 158 }], [24 * 30, { systolic: 134, diastolic: 86, heartRate: 80, respRate: 16, tempC: 36.8, spo2: 98, weightKg: 69.5, heightCm: 158 }], [2, { systolic: 142, diastolic: 90, heartRate: 84, respRate: 17, tempC: 36.9, spo2: 97, weightKg: 70.2, heightCm: 158 }]] as const) {
  for (const o of buildVitalsObservations(asha.id!, { ...v }, { effective: ago(h), performer: docRef })) await doc.createResource(o);
}
await doc.createResource(buildAllergy({ patientId: asha.id!, substance: 'Penicillin', type: 'allergy', category: 'medication', criticality: 'high', verification: 'confirmed', reaction: 'Hives and facial swelling', severity: 'severe', recorder: docRef }));
await doc.createResource(buildAllergy({ patientId: asha.id!, substance: 'Peanuts', type: 'allergy', category: 'food', criticality: 'low', verification: 'unconfirmed', reaction: 'Itching', severity: 'mild', recorder: docRef }));
const item = (k: string) => LIFESTYLE_ITEMS.find((i) => i.key === k)!;
await doc.createResource(buildLifestyleObservation(asha.id!, item('diet'), 'vegetarian', 'Lacto-vegetarian, no onion/garlic on fasting days', docRef));
await doc.createResource(buildLifestyleObservation(asha.id!, item('smoking'), undefined, 'Never smoked', docRef));
await doc.createResource(buildLifestyleObservation(asha.id!, item('activity'), undefined, 'Walks 30 min, 4 days/week', docRef));
await diet.createResource(buildNutritionOrder({ patientId: asha.id!, dietCodes: ['diabetic', 'low-salt'], instruction: '1600 kcal, low glycaemic index, salt < 5 g/day', foodPreference: 'Vegetarian', orderer: await me(diet), encounterId: ashaEncounter.id }));

const dx = [term('type 2 diabetes'), term('hypertension')];
for (const t of dx) conds.push(await doc.createResource(buildDiagnosisCondition({ term: t, verification: 'confirmed', patient: pref(asha), encounter: encRef, recorder: docRef, recordedDate: ago(1.5) })));
await doc.createResource(buildConsultDocumentReference({
  patient: pref(asha), encounter: encRef, author: docRef, date: ago(1.5), conditions: conds.map((c) => ({ reference: `Condition/${c.id}` })),
  soap: {
    subjective: 'Follow-up for diabetes. Reports increased thirst and nocturia for 2 weeks. Occasional morning headaches.',
    objective: 'BP 142/90, HR 84, BMI 28.1. No pedal oedema. Foot exam: intact sensation.',
    assessment: 'Type 2 diabetes, suboptimally controlled. Stage 1 hypertension.',
    plan: 'HbA1c and CBC ordered. Dietitian review for diabetic low-salt diet. Cardiology referral for BP management. Review in 2 weeks.',
  },
}));
}

// 3. Lab: CBC resulted via HL7 v2 ORU (lab tech) and signed off (pathologist); HbA1c still pending in queue.
const existingOrders = await admin.searchResources('ServiceRequest', { encounter: encRef.reference });
if (existingOrders.some((r) => r.code?.coding?.some((x) => x.code === '58410-2'))) {
  console.log('lab: already seeded, skipping');
} else {
const cbc = await createOrder(doc, { patientId: asha.id!, kind: 'laboratory', loinc: '58410-2', text: 'CBC panel', priority: 'routine', requesterId: docRef.reference!.split('/')[1], requesterName: docRef.display, encounterId: ashaEncounter.id });
await createOrder(doc, { patientId: asha.id!, kind: 'laboratory', loinc: '4548-4', text: 'Hemoglobin A1c', priority: 'routine', requesterId: docRef.reference!.split('/')[1], requesterName: docRef.display, encounterId: ashaEncounter.id });
await createOrder(doc, { patientId: ramesh.id!, kind: 'imaging', text: 'Chest X-ray PA view', priority: 'stat', requesterId: docRef.reference!.split('/')[1], requesterName: docRef.display, note: 'Rule out pulmonary oedema' });
const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const oru = [
  `MSH|^~\\&|LIS|STJONES-LAB|HINS|STJONES|${now}||ORU^R01|SHOWCASE-${now}|P|2.5`,
  `PID|1||${asha.id}^^^HINS||Verma^Asha`,
  `OBR|1||LAB-${now}|58410-2^CBC panel^LN|||${now}`,
  'OBX|1|NM|718-7^Hemoglobin [Mass/volume] in Blood^LN||11.2|g/dL|12.0-15.5|L|||F',
  'OBX|2|NM|6690-2^Leukocytes [#/volume] in Blood by Automated count^LN||7.8|10*3/uL|4.5-11.0|N|||F',
  'OBX|3|NM|777-3^Platelets [#/volume] in Blood by Automated count^LN||250|10*3/uL|150-400|N|||F',
].join('\r');
const labMe = (await me(lab)).reference!.split('/')[1];
const res = await importHl7Oru(lab, cbc.id!, oru, { uploaderId: labMe, identityConfirmed: true });
const pathMe = await me(patho);
await signOffReport(patho, res.report.id!, { conclusion: 'Mild normocytic anaemia; WBC and platelets normal. Correlate with iron studies.', interpreterId: pathMe.reference!.split('/')[1], interpreterName: pathMe.display });
console.log('lab: CBC resulted + signed; HbA1c pending; chest X-ray (stat) pending in radiology');
}

// 4. Inter-department referral: General Medicine -> Cardiology.
const cardiology = await findDepartment(admin, 'cardiology');
const refDone = (await admin.searchResources('ServiceRequest', { encounter: encRef.reference, performer: `Organization/${cardiology.id}` })).length > 0;
if (!refDone) await doc.createResource(buildReferral({
  patient: pref(asha), toDepartment: { reference: `Organization/${cardiology.id}`, display: cardiology.name }, requester: docRef, encounter: encRef,
  what: 'Cardiology consult', reason: 'Stage 1 hypertension with diabetes — BP management and cardiovascular risk assessment',
  reasonCondition: ((h) => (h ? { reference: `Condition/${h.id}` } : undefined))(conds.find((x) => x.code?.coding?.some((k) => k.code === '38341003'))), priority: 'routine', authoredOn: ago(1),
}));
console.log('Showcase data created.');
