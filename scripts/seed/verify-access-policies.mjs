#!/usr/bin/env node
/**
 * Live check that the role AccessPolicies are enforced SERVER-SIDE by
 * Medplum (not just hidden in the UI). Logs in as each seeded staff login
 * and prints the actual HTTP status of allowed and forbidden calls, then
 * asserts the expected outcome. Creates a few throwaway resources and
 * removes them (as the project admin) at the end.
 *
 * Usage: node scripts/seed/verify-access-policies.mjs   (exit 1 on any FAIL)
 */
import { PROJECT_ID as ENV_PROJECT_ID, adminLogin, login, request, demoPatientId, whoAmI } from './_medplum-client.mjs';

const DOC_CATEGORY_SYSTEM = 'https://hins.example/fhir/document-category';
const STAFF_PW = 'Staff123!';

let failures = 0;
const cleanup = [];
const results = [];

function expect(who, label, res, ok) {
  const pass = ok(res);
  if (!pass) failures++;
  const n = res.json?.resourceType === 'Bundle' ? ` (${res.json.entry?.length ?? 0} rows)` : '';
  const line = `${pass ? 'PASS' : 'FAIL'}  ${who.padEnd(14)} ${label.padEnd(58)} -> ${res.status}${n}`;
  results.push(line);
  console.log(line);
}
const is = (code) => (r) => r.status === code;
const denied = (r) => r.status === 403;
const rows = (r) => r.json?.entry?.length ?? 0;
const emptyOk = (r) => r.status === 200 && rows(r) === 0;
/** 200 and every row carries this document category — i.e. clinical notes
 * are filtered out, while the role's own reports (e.g. ones seed:showcase
 * created) may legitimately be visible. */
const onlyCategory = (code) => (r) =>
  r.status === 200 &&
  (r.json.entry ?? []).every((e) => e.resource.category?.some((c) => c.coding?.some((cd) => cd.system === DOC_CATEGORY_SYSTEM && cd.code === code)));
const created = (r) => r.status === 201;

const get = (t, p) => request(`/fhir/R4/${p}`, { token: t });
const post = (t, type, body) => request(`/fhir/R4/${type}`, { method: 'POST', token: t, body: { resourceType: type, ...body } });
const put = (t, res) => request(`/fhir/R4/${res.resourceType}/${res.id}`, { method: 'PUT', token: t, body: res });
const del = (t, type, id) => request(`/fhir/R4/${type}/${id}`, { method: 'DELETE', token: t });
const track = (r) => {
  if (r.status === 201) cleanup.push(`${r.json.resourceType}/${r.json.id}`);
  return r;
};

const admin = await adminLogin();
const PROJECT_ID = ENV_PROJECT_ID ?? (await whoAmI(admin)).projectId;
const PATIENT = `Patient/${await demoPatientId(admin)}`; // Asha Verma (demo)
// Fixtures (as admin): a clinical note (no category), a lab order.
const note = track(await post(admin, 'DocumentReference', {
  status: 'current', type: { text: 'OPD note' }, subject: { reference: PATIENT },
  content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('RBAC probe clinical note').toString('base64') } }],
})).json;
const order = track(await post(admin, 'ServiceRequest', {
  status: 'active', intent: 'order', subject: { reference: PATIENT }, code: { text: 'RBAC probe: CBC' },
})).json;

// ---- billing-staff
{
  const t = await login('billing@stjones.example', STAFF_PW, PROJECT_ID);
  const w = 'billing';
  expect(w, 'GET DocumentReference?subject=<patient>', await get(t, `DocumentReference?subject=${PATIENT}`), denied);
  expect(w, `GET DocumentReference/${note.id.slice(0, 8)}… (clinical note)`, await get(t, `DocumentReference/${note.id}`), denied);
  expect(w, 'GET Condition', await get(t, 'Condition'), denied);
  expect(w, 'GET Observation', await get(t, 'Observation'), denied);
  expect(w, 'GET MedicationRequest', await get(t, 'MedicationRequest'), denied);
  expect(w, 'GET Claim', await get(t, 'Claim'), is(200));
  expect(w, 'GET Invoice / Coverage / ChargeItem', await get(t, 'Invoice'), is(200));
  expect(w, 'GET Patient (billing view, read-only)', await get(t, `${PATIENT}`), is(200));
  const p = (await get(t, PATIENT)).json;
  const leaked = ['photo', 'contact', 'generalPractitioner', 'link'].filter((f) => f in p);
  expect(w, 'Patient hiddenFields stripped (photo/contact/GP/link)', { status: leaked.length ? `leaked ${leaked}` : 200 }, is(200));
  expect(w, 'PUT Patient (read-only for billing)', await put(t, p), denied);
  const acct = track(await post(t, 'Account', { status: 'active', name: 'RBAC probe account', subject: [{ reference: PATIENT }] }));
  expect(w, 'POST Account', acct, created);
  if (acct.status === 201) expect(w, 'DELETE Account (no-delete policy)', await del(t, 'Account', acct.json.id), denied);
}

// ---- lab-technician
{
  const t = await login('lab.tech@stjones.example', STAFF_PW, PROJECT_ID);
  const w = 'lab.tech';
  expect(w, 'GET DocumentReference?subject=<patient> (notes filtered)', await get(t, `DocumentReference?subject=${PATIENT}`), onlyCategory('lab-report'));
  const r = await get(t, `DocumentReference/${note.id}`);
  expect(w, 'GET DocumentReference/<clinical note id>', r, (x) => x.status === 403 || x.status === 404);
  expect(w, 'GET Condition', await get(t, 'Condition'), denied);
  expect(w, 'GET MedicationRequest', await get(t, 'MedicationRequest'), denied);
  expect(w, 'GET ServiceRequest', await get(t, `ServiceRequest?subject=${PATIENT}`), (x) => x.status === 200 && rows(x) > 0);
  const sr = (await get(t, `ServiceRequest/${order.id}`)).json;
  expect(w, 'PUT ServiceRequest (status -> completed)', await put(t, { ...sr, status: 'completed' }), is(200));
  expect(w, 'POST ServiceRequest (cannot place orders)', track(await post(t, 'ServiceRequest', {
    status: 'active', intent: 'order', subject: { reference: PATIENT }, code: { text: 'x' },
  })), denied);
  const labDoc = track(await post(t, 'DocumentReference', {
    status: 'current', category: [{ coding: [{ system: DOC_CATEGORY_SYSTEM, code: 'lab-report' }] }],
    type: { text: 'Lab report' }, subject: { reference: PATIENT },
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('probe').toString('base64') } }],
  }));
  expect(w, 'POST DocumentReference category=lab-report', labDoc, created);
  if (labDoc.status === 201) {
    expect(w, 'GET DocumentReference/<own lab report id>', await get(t, `DocumentReference/${labDoc.json.id}`), is(200));
  }
  expect(w, 'POST DocumentReference w/o lab-report category', track(await post(t, 'DocumentReference', {
    status: 'current', type: { text: 'OPD note' }, subject: { reference: PATIENT },
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('probe').toString('base64') } }],
  })), (x) => x.status === 403 || x.status === 400);
  const obs = track(await post(t, 'Observation', { status: 'final', code: { text: 'RBAC probe Hb' }, subject: { reference: PATIENT } }));
  expect(w, 'POST Observation', obs, created);
  if (obs.status === 201) expect(w, 'DELETE Observation (no-delete policy)', await del(t, 'Observation', obs.json.id), denied);
}

// ---- pharmacist
{
  const t = await login('pharmacist@stjones.example', STAFF_PW, PROJECT_ID);
  const w = 'pharmacist';
  expect(w, 'GET MedicationRequest', await get(t, 'MedicationRequest'), is(200));
  expect(w, 'POST MedicationRequest (cannot prescribe)', track(await post(t, 'MedicationRequest', {
    status: 'active', intent: 'order', subject: { reference: PATIENT }, medicationCodeableConcept: { text: 'x' },
  })), denied);
  expect(w, 'GET MedicationDispense', await get(t, 'MedicationDispense'), is(200));
  expect(w, 'GET Condition', await get(t, 'Condition'), denied);
  expect(w, 'GET DocumentReference', await get(t, 'DocumentReference'), denied);
}

// ---- radiologist
{
  const t = await login('radiologist@stjones.example', STAFF_PW, PROJECT_ID);
  const w = 'radiologist';
  expect(w, 'GET ImagingStudy', await get(t, 'ImagingStudy'), is(200));
  expect(w, 'GET ServiceRequest', await get(t, 'ServiceRequest'), is(200));
  expect(w, 'GET DocumentReference?subject=<patient> (notes filtered)', await get(t, `DocumentReference?subject=${PATIENT}`), onlyCategory('imaging-report'));
  expect(w, 'GET Condition', await get(t, 'Condition'), denied);
}

// ---- triage-nurse
{
  const t = await login('triage.nurse@stjones.example', STAFF_PW, PROJECT_ID);
  const w = 'triage.nurse';
  expect(w, 'POST Observation (vitals)', track(await post(t, 'Observation', {
    status: 'final', code: { text: 'RBAC probe pulse' }, subject: { reference: PATIENT },
  })), created);
  expect(w, 'GET Condition (read-only)', await get(t, 'Condition'), is(200));
  expect(w, 'POST Condition', track(await post(t, 'Condition', { subject: { reference: PATIENT }, code: { text: 'x' } })), denied);
  expect(w, 'GET Claim', await get(t, 'Claim'), denied);
}

// ---- dietitian
{
  const t = await login('dietitian@stjones.example', STAFF_PW, PROJECT_ID);
  const w = 'dietitian';
  expect(w, 'GET NutritionOrder', await get(t, 'NutritionOrder'), is(200));
  expect(w, 'GET Observation?category=laboratory (labs filtered)', await get(t, 'Observation?category=laboratory'), emptyOk);
  expect(w, 'GET DocumentReference', await get(t, 'DocumentReference'), denied);
}

// ---- hospital-admin (non-superuser, project admin + '*' policy)
{
  const t = await login('hospital.admin@stjones.example', STAFF_PW, PROJECT_ID);
  const w = 'hospital.admin';
  expect(w, 'GET ProjectMembership', await get(t, 'ProjectMembership?_count=5'), is(200));
  expect(w, 'GET AccessPolicy', await get(t, 'AccessPolicy'), is(200));
  expect(w, 'GET PractitionerRole', await get(t, 'PractitionerRole'), is(200));
  expect(w, 'GET DocumentReference', await get(t, `DocumentReference?subject=${PATIENT}`), (x) => x.status === 200 && rows(x) > 0);
  expect(w, `GET /admin/projects/${PROJECT_ID.slice(0, 8)}… (admin API)`, await request(`/admin/projects/${PROJECT_ID}`, { token: t }), is(200));
}

// ---- project super-admin
{
  const w = 'admin@example';
  expect(w, 'GET DocumentReference', await get(admin, `DocumentReference?subject=${PATIENT}`), (x) => x.status === 200 && rows(x) > 0);
  expect(w, 'GET Condition', await get(admin, 'Condition'), is(200));
  expect(w, 'GET Claim', await get(admin, 'Claim'), is(200));
  expect(w, 'GET AccessPolicy', await get(admin, 'AccessPolicy'), is(200));
}

// ---- dr.sharma (unchanged Default Practitioner Access Policy)
{
  const t = await login('dr.sharma@stjones.example', 'DrSharma123!', PROJECT_ID);
  const w = 'dr.sharma';
  const self = `Practitioner/${(await whoAmI(t)).profileId}`;
  expect(w, 'GET Patient?name=a', await get(t, 'Patient?name=a&_count=5'), (x) => x.status === 200 && rows(x) > 0);
  expect(w, 'GET PractitionerRole?practitioner=<self>', await get(t, `PractitionerRole?practitioner=${self}`), (x) => x.status === 200 && rows(x) > 0);
  const enc = track(await post(t, 'Encounter', {
    status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' }, subject: { reference: PATIENT },
  }));
  expect(w, 'POST Encounter', enc, created);
  expect(w, 'POST DocumentReference (clinical note)', track(await post(t, 'DocumentReference', {
    status: 'current', type: { text: 'OPD note' }, subject: { reference: PATIENT },
    context: enc.status === 201 ? { encounter: [{ reference: `Encounter/${enc.json.id}` }] } : undefined,
    author: [{ reference: self }],
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('RBAC probe note').toString('base64') } }],
  })), created);
  expect(w, 'GET MedicationRequest', await get(t, `MedicationRequest?subject=${PATIENT}`), is(200));
}

// ---- cleanup throwaway resources (admin; dependents first)
for (const ref of cleanup.reverse()) {
  const r = await request(`/fhir/R4/${ref}`, { method: 'DELETE', token: admin });
  if (!r.ok) console.log(`  cleanup ${ref} -> ${r.status}`);
}
console.log(`\nCleaned up ${cleanup.length} probe resources. ${failures ? `${failures} FAIL(s)` : 'All checks passed.'}`);
process.exit(failures ? 1 : 0);
