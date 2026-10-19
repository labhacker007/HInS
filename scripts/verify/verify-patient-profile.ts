#!/usr/bin/env node
/**
 * Live verification for the patient-profile track. Imports the SAME builders
 * the UI uses (apps/web/src/lib/patientProfile.ts) and writes them through a
 * real MedplumClient as Dr. Sharma against the running Medplum, re-reading
 * every write fresh (cache: 'reload'). Test resources (Observations,
 * AllergyIntolerance, NutritionOrder) are deleted at the end; the Patient's
 * demographics update is intentionally kept (sensible demo values).
 *
 * Usage (Node >= 22.18, native TypeScript type stripping):
 *   node scripts/verify/verify-patient-profile.ts
 */
import { randomBytes } from 'node:crypto';
import { MedplumClient } from '@medplum/core';
import type { Observation, NutritionOrder, Resource } from '@medplum/fhirtypes';
import {
  ABHA_ADDRESS_SYSTEM,
  ABHA_NUMBER_SYSTEM,
  BLOOD_GROUP_CODE,
  LIFESTYLE_ITEMS,
  applyDemographics,
  buildAllergy,
  buildLifestyleObservation,
  buildNutritionOrder,
  buildVitalsObservations,
  isValidAbhaAddress,
  isValidPhone,
  latestObservation,
  markAllergyEnteredInError,
  normalizeAbhaNumber,
  patientToForm,
  saveDemographics,
  validateDemographics,
  validateVitals,
} from '../../apps/web/src/lib/patientProfile.ts';

// @ts-expect-error -- plain .mjs helper shared with the seed scripts (also loads .env)
import { demoPatientId } from '../seed/_medplum-client.mjs';

const BASE = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
const PROJECT = process.env.MEDPLUM_PROJECT_ID || undefined; // written to .env by `npm run bootstrap`
// Resolved live in main() — never one machine's hardcoded ids.
let PATIENT_ID = '';
let PRACTITIONER = { reference: '', display: 'Dr. Sharma' };

let failures = 0;
function check(label: string, cond: unknown, extra?: unknown): void {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function login(email: string, password: string, projectId?: string): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  // /auth/* is rate-limited (5/min, shared with other dev sessions): wait and retry on 429.
  const post = async (path: string, body: unknown): Promise<any> => {
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (r.status === 429 && attempt < 6) {
        const wait = (j.extension?.[0]?.valueUnsignedInt ?? 30) + 2;
        console.log(`  (auth rate-limited, waiting ${wait}s)`);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
      return j;
    }
  };
  let resp = await post('/auth/login', { email, password, codeChallengeMethod: 'plain', codeChallenge: verifier, projectId });
  if (resp.memberships) {
    const m = resp.memberships.find((x: { project: { display: string } }) => x.project.display === 'HInS Dev');
    resp = await post('/auth/profile', { login: resp.login, profile: m.id });
  }
  const tr = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: resp.code, code_verifier: verifier }),
  });
  return (await tr.json()).access_token;
}

const created: Resource[] = [];
const track = <T extends Resource>(r: T): T => (created.push(r), r);

async function main(): Promise<void> {
  const medplum = new MedplumClient({ baseUrl: BASE, fetch });
  medplum.setAccessToken(await login('dr.sharma@stjones.example', 'DrSharma123!', PROJECT));
  PATIENT_ID = await demoPatientId();
  PRACTITIONER = { reference: `Practitioner/${(await medplum.get('auth/me')).profile.id}`, display: 'Dr. Sharma' };

  console.log('\n[1] validators');
  check('ABHA number normalised', normalizeAbhaNumber('91 1234 5678 9012') === '91-1234-5678-9012');
  check('ABHA number 13 digits rejected', normalizeAbhaNumber('9112345678901') === undefined);
  check('ABHA address @abdm ok', isValidAbhaAddress('asha.verma@abdm'));
  check('ABHA address @sbx ok', isValidAbhaAddress('ashaverma_88@sbx'));
  check('ABHA address bad domain rejected', !isValidAbhaAddress('asha.verma@gmail'));
  check('ABHA address two dots rejected', !isValidAbhaAddress('a.sha.verma@abdm'));
  check('ABHA address too short rejected', !isValidAbhaAddress('asha@abdm'));
  check('Indian mobile ok', isValidPhone('+91 98765 43210'));
  check('landline-ish 5xxx rejected', !isValidPhone('5876543210'));
  const bad = validateDemographics({ ...patientToForm(undefined), givenFirst: 'A', family: 'B', birthDate: '2999-01-01', pin: '012345', abhaNumber: '12' });
  check('form errors: future DOB, bad PIN, bad ABHA', bad.birthDate && bad.pin && bad.abhaNumber, bad);

  console.log('\n[2] demographics (Patient update + blood group/occupation Observations)');
  const before = await medplum.readResource('Patient', PATIENT_ID, { cache: 'reload' });
  const form = {
    ...patientToForm(before),
    prefix: 'Ms.',
    givenFirst: 'Asha',
    givenMiddle: '',
    family: 'Verma',
    gender: 'female',
    birthDate: '1988-04-12',
    maritalStatus: 'M',
    language: 'hi',
    phone: '+91 98765 43210',
    email: 'asha.verma.patient@example.com',
    addrLine: '14 Lajpat Nagar, Block C',
    city: 'New Delhi',
    district: 'South East Delhi',
    state: 'Delhi',
    pin: '110024',
    country: 'IN',
    ecName: 'Rohit Verma',
    ecRelationship: 'Spouse',
    ecPhone: '9876501234',
    occupation: 'School teacher',
    bloodGroup: 'B+',
    abhaNumber: '91123456789012',
    abhaAddress: 'asha.verma@sbx',
  };
  check('demo form validates', Object.keys(validateDemographics(form)).length === 0, validateDemographics(form));
  await saveDemographics(medplum, form, before, {}, PRACTITIONER);
  const after = await medplum.readResource('Patient', PATIENT_ID, { cache: 'reload' });
  check('name prefix/given/family', after.name?.[0]?.prefix?.[0] === 'Ms.' && after.name?.[0]?.family === 'Verma', after.name);
  check('DOB + gender', after.birthDate === '1988-04-12' && after.gender === 'female');
  check('marital status M', after.maritalStatus?.coding?.[0]?.code === 'M');
  check('preferred language hi', after.communication?.[0]?.preferred && after.communication[0].language.coding?.[0]?.code === 'hi');
  check('email preserved (incl. original use)', after.telecom?.some((t) => t.system === 'email' && t.use === 'work' && t.value === 'asha.verma.patient@example.com'));
  check('phone added', after.telecom?.some((t) => t.system === 'phone'));
  const a = after.address?.[0];
  check('address district/state/PIN', a?.district === 'South East Delhi' && a?.state === 'Delhi' && a?.postalCode === '110024', a);
  check('emergency contact v2-0131 C + Spouse', after.contact?.[0]?.relationship?.some((r) => r.coding?.[0]?.code === 'C') && after.contact[0].relationship.some((r) => r.text === 'Spouse'));
  const abha = after.identifier?.find((i) => i.system === ABHA_NUMBER_SYSTEM);
  check('ABHA number stored XX-XXXX-XXXX-XXXX w/ type HIN', abha?.value === '91-1234-5678-9012' && abha.type?.coding?.[0]?.code === 'HIN', abha);
  check('ABHA address stored (placeholder system)', after.identifier?.find((i) => i.system === ABHA_ADDRESS_SYSTEM)?.value === 'asha.verma@sbx');
  check('round-trip form', JSON.stringify({ ...patientToForm(after), occupation: '', bloodGroup: '' }) === JSON.stringify({ ...form, occupation: '', bloodGroup: '', abhaNumber: '91-1234-5678-9012', phone: '+91 98765 43210' }), patientToForm(after));
  const bg = await latestObservation(medplum, PATIENT_ID, BLOOD_GROUP_CODE);
  check('blood group Observation LOINC 882-1 = B+', bg?.valueCodeableConcept?.text === 'B+');
  if (bg) track(bg);
  const occ = await medplum.searchResources('Observation', { subject: `Patient/${PATIENT_ID}`, code: 'http://loinc.org|11341-5' }, { cache: 'reload' });
  occ.forEach(track);
  check('occupation Observation saved', occ.some((o) => o.valueCodeableConcept?.text === 'School teacher'));
  await saveDemographics(medplum, form, after, {}, PRACTITIONER);
  const bgAll = await medplum.searchResources('Observation', { subject: `Patient/${PATIENT_ID}`, code: 'http://loinc.org|882-1' }, { cache: 'reload' });
  bgAll.forEach((o) => !created.some((c) => c.id === o.id) && track(o));
  check('unchanged re-save adds no duplicate blood group', bgAll.length === 1, bgAll.length);
  const idem = applyDemographics(after, patientToForm(after));
  check('applyDemographics is idempotent on unchanged form (MRN/other fields kept)', JSON.stringify(idem.identifier) === JSON.stringify(after.identifier));

  console.log('\n[3] social history + diet');
  for (const item of LIFESTYLE_ITEMS) {
    const ans = item.answers?.[0]?.code;
    const o = track(await medplum.createResource(buildLifestyleObservation(PATIENT_ID, item, ans, item.freeText ? 'Breakfast, lunch, dinner + evening tea' : 'verify', PRACTITIONER)));
    const fresh = await medplum.readResource('Observation', o.id as string, { cache: 'reload' });
    check(`${item.label} saved (${fresh.valueCodeableConcept?.text})`, fresh.category?.[0]?.coding?.[0]?.code === 'social-history');
  }
  const smoke = created.find((r) => (r as Observation).code?.coding?.[0]?.code === '72166-2') as Observation;
  check('smoking uses SNOMED answer', smoke.valueCodeableConcept?.coding?.[0]?.system === 'http://snomed.info/sct');
  const eie = await medplum.updateResource({ ...smoke, status: 'entered-in-error' });
  check('social-history obs → entered-in-error accepted', eie.status === 'entered-in-error');

  console.log('\n[4] allergies');
  const al = track(
    await medplum.createResource(
      buildAllergy({ patientId: PATIENT_ID, substance: 'Peanuts', type: 'allergy', category: 'food', criticality: 'high', verification: 'confirmed', reaction: 'Hives, lip swelling', severity: 'moderate', recorder: PRACTITIONER }),
    ),
  );
  const alFresh = await medplum.readResource('AllergyIntolerance', al.id as string, { cache: 'reload' });
  check('allergy saved with reaction + criticality', alFresh.reaction?.[0]?.manifestation?.[0]?.text === 'Hives, lip swelling' && alFresh.criticality === 'high');
  const lac = track(await medplum.createResource(buildAllergy({ patientId: PATIENT_ID, substance: 'Lactose', type: 'intolerance', category: 'food', criticality: 'low', verification: 'unconfirmed' })));
  check('food intolerance saved', lac.type === 'intolerance');
  let rejected = false;
  try {
    await medplum.updateResource({ ...alFresh, verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification', code: 'entered-in-error' }] } });
  } catch {
    rejected = true;
  }
  console.log(`  info: naive entered-in-error WITH clinicalStatus ${rejected ? 'rejected by server (ait-2 enforced)' : 'accepted by server (ait-2 not enforced)'}`);
  const alLatest = await medplum.readResource('AllergyIntolerance', al.id as string, { cache: 'reload' });
  const marked = await medplum.updateResource(markAllergyEnteredInError(alLatest));
  const markedFresh = await medplum.readResource('AllergyIntolerance', marked.id as string, { cache: 'reload' });
  check('allergy marked entered-in-error, clinicalStatus removed', markedFresh.verificationStatus?.coding?.[0]?.code === 'entered-in-error' && !markedFresh.clinicalStatus);
  const hist = await medplum.readHistory('AllergyIntolerance', al.id as string);
  check('prior version kept in history', (hist.entry?.length ?? 0) >= 2, hist.entry?.length);

  console.log('\n[5] diet orders (NutritionOrder)');
  // Same lookups PatientLifestyle.tsx DietOrders.place() runs before ordering.
  const [pref] = await medplum.searchResources(
    'Observation',
    { subject: `Patient/${PATIENT_ID}`, code: 'https://hins.example/fhir/CodeSystem/social-history|diet-preference', 'status:not': 'entered-in-error', _sort: '-date', _count: 1 },
    { cache: 'reload' },
  );
  check('diet-preference lookup', pref?.valueCodeableConcept?.text === 'Vegetarian', pref);
  const foodActive = await medplum.searchResources(
    'AllergyIntolerance',
    { patient: `Patient/${PATIENT_ID}`, category: 'food', 'verification-status:not': 'entered-in-error' },
    { cache: 'reload' },
  );
  check('active food allergies lookup excludes entered-in-error (Peanuts) keeps Lactose', foodActive.length === 1 && foodActive[0].code?.text === 'Lactose', foodActive.map((x) => x.code?.text));
  const social = await medplum.searchResources('Observation', { subject: `Patient/${PATIENT_ID}`, category: 'social-history', _sort: '-date', _count: 200 }, { cache: 'reload' });
  check('social-history tab query returns entries', social.length >= 6, social.length);
  const no = track(
    await medplum.createResource(
      buildNutritionOrder({ patientId: PATIENT_ID, dietCodes: ['diabetic', 'low-salt'], instruction: '1800 kcal, no added salt', foodPreference: 'Vegetarian', allergyIds: [lac.id as string], orderer: PRACTITIONER }),
    ),
  );
  const noFresh = await medplum.readResource('NutritionOrder', no.id as string, { cache: 'reload' });
  check('NutritionOrder active, 2 diet types, orderer', noFresh.status === 'active' && noFresh.oralDiet?.type?.length === 2 && noFresh.orderer?.reference === PRACTITIONER.reference);
  const npo = track(await medplum.createResource(buildNutritionOrder({ patientId: PATIENT_ID, dietCodes: ['npo'], orderer: PRACTITIONER })));
  const held = await medplum.updateResource({ ...npo, status: 'on-hold' } as NutritionOrder);
  check('NPO order → on-hold', held.status === 'on-hold');
  const listed = await medplum.searchResources('NutritionOrder', { patient: `Patient/${PATIENT_ID}`, _sort: '-_lastUpdated' }, { cache: 'reload' });
  check('NutritionOrder search by patient (chart list query)', listed.length >= 2, listed.length);

  console.log('\n[6] vitals');
  const vit = { systolic: 128, diastolic: 84, heartRate: 78, respRate: 16, tempC: 36.9, spo2: 98, weightKg: 62, heightCm: 158 };
  check('vitals validate', validateVitals(vit).length === 0, validateVitals(vit));
  check('diastolic>=systolic rejected', validateVitals({ systolic: 80, diastolic: 90 }).length > 0);
  const obs = buildVitalsObservations(PATIENT_ID, vit, { performer: PRACTITIONER });
  check('8 vitals built incl. computed BMI 24.8', obs.length === 8 && obs.find((o) => o.code?.coding?.[0]?.code === '39156-5')?.valueQuantity?.value === 24.8);
  for (const o of obs) {
    try {
      const c = track(await medplum.createResource(o));
      const f = await medplum.readResource('Observation', c.id as string, { cache: 'reload' });
      check(`vital ${o.code?.text} saved (profile vitalsigns)`, f.meta?.profile?.[0]?.endsWith('vitalsigns') && f.effectiveDateTime === o.effectiveDateTime);
    } catch (err) {
      check(`vital ${o.code?.text} saved`, false, String(err));
    }
  }
  const trend = await medplum.searchResources('Observation', { subject: `Patient/${PATIENT_ID}`, category: 'vital-signs', _sort: '-date', _count: 100 }, { cache: 'reload' });
  check('trend query returns this reading', trend.filter((o) => o.effectiveDateTime === obs[0].effectiveDateTime).length === 8, trend.length);
  const bmiOnly = buildVitalsObservations(PATIENT_ID, { weightKg: 60 }, { fallbackHeightCm: 158 });
  check('BMI from fallback height', bmiOnly.length === 2 && bmiOnly[1].valueQuantity?.value === 24);
}

async function cleanup(): Promise<void> {
  if (!created.length) return;
  const admin = new MedplumClient({ baseUrl: BASE, fetch });
  admin.setAccessToken(await login('admin@example.com', 'medplum_admin'));
  // Delete NutritionOrders before the AllergyIntolerance they reference.
  const order = (r: Resource) => (r.resourceType === 'NutritionOrder' ? 0 : 1);
  let n = 0;
  for (const r of [...created].sort((x, y) => order(x) - order(y))) {
    try {
      await admin.deleteResource(r.resourceType, r.id as string);
      n++;
    } catch (err) {
      console.log(`  cleanup failed ${r.resourceType}/${r.id}: ${err}`);
    }
  }
  console.log(`\n[cleanup] deleted ${n}/${created.length} test resources (Patient demographics kept)`);
}

main()
  .catch((err) => {
    failures++;
    console.error(err);
  })
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
  });

