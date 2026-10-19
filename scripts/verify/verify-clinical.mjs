#!/usr/bin/env node
/**
 * Live verification for the clinical track (triage, consult note, coded
 * diagnoses, referrals). Imports the SAME builders the UI uses
 * (apps/web/src/lib/clinical.ts + terminology.ts) via Node's TypeScript
 * type stripping (Node >= 22.18), runs the same searches the pages run,
 * asserts the results, then deletes everything it created (admin login).
 *
 * Usage: node scripts/verify/verify-clinical.mjs
 */
import { login, PROJECT_ID } from './medplum-login.mjs';
import * as C from '../../apps/web/src/lib/clinical.ts';
import { search } from '../../apps/web/src/lib/terminology.ts';

const DEPT_SYSTEM = 'https://hins.example/fhir/department';
const created = [];
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const dr = await login('dr.sharma@stjones.example', 'DrSharma123!', { projectId: PROJECT_ID });
const fhir = dr.fhir;
const create = async (r) => {
  const out = await fhir(r.resourceType, { method: 'POST', body: r });
  created.push(`${out.resourceType}/${out.id}`);
  return out;
};
const me = dr.profile;

try {
  const dept = async (code) => (await fhir(`Organization?identifier=${encodeURIComponent(`${DEPT_SYSTEM}|${code}`)}`)).entry[0].resource;
  const emergency = await dept('emergency');
  const cardiology = await dept('cardiology');
  const ref = (o) => ({ reference: `Organization/${o.id}`, display: o.name });

  const patient = await create({ resourceType: 'Patient', name: [{ given: ['Zz'], family: 'VerifyClinical' }], gender: 'other' });
  const pRef = { reference: `Patient/${patient.id}`, display: 'Zz VerifyClinical' };

  // ---- 1. Triage: 3 visits, varying acuity/arrival ----
  const now = Date.now();
  const mk = async (acuity, minsAgo, vitals) => {
    const arrival = new Date(now - minsAgo * 60000).toISOString();
    const enc = await create(
      C.buildTriageEncounter({ patient: pRef, department: ref(emergency), departmentCode: 'emergency', arrival, chiefComplaint: `test complaint a${acuity} t-${minsAgo}`, acuity, triagedBy: me })
    );
    const obs = C.buildTriageObservations({ patient: pRef, encounter: { reference: `Encounter/${enc.id}` }, performer: me, effective: new Date().toISOString(), vitals, pain: 6, acuity });
    for (const o of obs) await create(o);
    return { enc, nObs: obs.length };
  };
  const a3old = await mk(3, 60, { systolic: 150, diastolic: 95, heartRate: 88, respRate: 18, temperature: 37.2, spo2: 97 });
  const a1 = await mk(1, 5, { heartRate: 130, spo2: 86 });
  const a3new = await mk(3, 30, {});
  check(a3old.enc.status === 'triaged' && a3old.enc.class.code === 'EMER', 'triage Encounter created: status triaged, class EMER');
  check(a3old.enc.priority.coding.some((c) => c.code === 'UR') && C.acuityOf(a3old.enc) === 3, 'Encounter.priority carries ActPriority UR + acuity 3');

  const obs = (await fhir(`Observation?encounter=Encounter/${a3old.enc.id}&_count=50`)).entry.map((e) => e.resource);
  const codes = obs.map((o) => o.code.coding[0].code).sort();
  check(obs.length === 8, `8 Observations on full-vitals encounter (got ${obs.length})`);
  for (const c of ['8480-6', '8462-4', '8867-4', '9279-1', '8310-5', '59408-5', '72514-3', '75636-1'])
    check(codes.includes(c), `Observation LOINC ${c} present`);
  check(obs.find((o) => o.code.coding[0].code === '8310-5').valueQuantity.code === 'Cel', 'temperature in UCUM Cel');
  check(obs.find((o) => o.code.coding[0].code === '75636-1').valueInteger === 3, 'ESI observation value 3');
  check(a1.nObs === 4, `partial vitals -> only recorded values + pain + ESI (got ${a1.nObs})`);

  // ---- 2. Queue: same query the TriageQueue page runs ----
  const since = new Date(now - 48 * 3600 * 1000).toISOString();
  const q = await fhir(
    `Encounter?type=${encodeURIComponent(`${C.HINS_ENCOUNTER_TYPE}|triage-visit`)}&status=arrived,triaged,in-progress&date=ge${encodeURIComponent(since)}&service-provider=Organization/${emergency.id}&_count=200`
  );
  const mine = C.sortTriageQueue(q.entry.map((e) => e.resource)).filter((e) => e.subject.reference === pRef.reference);
  check(
    JSON.stringify(mine.map((e) => e.id)) === JSON.stringify([a1.enc.id, a3old.enc.id, a3new.enc.id]),
    'queue order: acuity 1 first, then acuity 3 earliest-arrival first'
  );
  const qCardio = await fhir(`Encounter?type=${encodeURIComponent(`${C.HINS_ENCOUNTER_TYPE}|triage-visit`)}&service-provider=Organization/${cardiology.id}&subject=${pRef.reference}`);
  check(!qCardio.entry?.length, 'emergency triage visits not in cardiology-filtered queue');

  // Start consult: status transition (fresh read, then update) like TriageQueue.transition
  const fresh = await fhir(`Encounter/${a1.enc.id}`);
  const inProg = await fhir(`Encounter/${a1.enc.id}`, { method: 'PUT', body: { ...fresh, status: 'in-progress' } });
  check(C.queueStatus(inProg) === 'in-consult', 'Start consult -> in-progress (in-consult)');
  const eie = await fhir(`Encounter/${a3new.enc.id}`, { method: 'PUT', body: { ...a3new.enc, status: 'entered-in-error' } });
  check(eie.status === 'entered-in-error', 'rollback path: Encounter entered-in-error accepted');

  // ---- 3. Consult note + coded diagnoses ----
  const asthma = search('asthma')[0];
  const htn = search('hypertension')[0];
  check(asthma.snomed === '195967001' && asthma.icd10 === 'J45.9', 'terminology search asthma -> 195967001 / J45.9');
  check(htn.snomed === '38341003' && htn.icd10 === 'I10', 'terminology search hypertension -> 38341003 / I10');
  const encRef = { reference: `Encounter/${a1.enc.id}` };
  const at = new Date().toISOString();
  const cond1 = await create(C.buildDiagnosisCondition({ term: asthma, verification: 'provisional', patient: pRef, encounter: encRef, recorder: me, recordedDate: at }));
  const cond2 = await create(C.buildDiagnosisCondition({ term: htn, verification: 'confirmed', patient: pRef, encounter: encRef, recorder: me, recordedDate: at }));
  const soap = { subjective: 'Wheeze x2 days', objective: 'SpO2 86% RA', assessment: 'Acute asthma, raised BP', plan: 'Nebulise; refer cardiology' };
  const doc = await create(
    C.buildConsultDocumentReference({ soap, patient: pRef, encounter: encRef, author: me, conditions: [cond1, cond2].map((c) => ({ reference: `Condition/${c.id}` })), date: at })
  );
  const c1 = await fhir(`Condition/${cond1.id}`);
  check(
    c1.code.coding.some((c) => c.system === 'http://snomed.info/sct' && c.code === '195967001') &&
      c1.code.coding.some((c) => c.system === 'http://hl7.org/fhir/sid/icd-10' && c.code === 'J45.9'),
    'Condition has SNOMED + ICD-10 codings'
  );
  check(c1.verificationStatus.coding[0].code === 'provisional' && c1.clinicalStatus.coding[0].code === 'active', 'Condition provisional + active');
  check(c1.encounter.reference === encRef.reference && c1.recorder.reference === me.reference, 'Condition linked to encounter + recorder');
  const d = await fhir(`DocumentReference/${doc.id}`);
  check(d.type.coding[0].code === '11488-4' && d.author[0].reference === me.reference, 'DocumentReference LOINC 11488-4, author = practitioner');
  check(d.context.encounter[0].reference === encRef.reference && d.context.related.length === 2, 'DocumentReference linked to encounter + 2 Conditions');
  const text = atob(d.content[0].attachment.data); // same decode VersionedNote uses
  check(text.includes('SUBJECTIVE:\nWheeze') && text.includes('PLAN:\nNebulise'), 'SOAP body decodes with atob (VersionedNote-compatible)');
  const byEnc = await fhir(`Condition?encounter=${encRef.reference}`);
  check(byEnc.entry?.length === 2, 'Conditions searchable by encounter');

  // ---- 4. Referral to cardiology, seen in cardiology inbox only ----
  const sr = await create(
    C.buildReferral({ patient: pRef, toDepartment: ref(cardiology), requester: me, encounter: encRef, what: 'Cardiology opinion', reason: 'Raised BP in ED', reasonCondition: { reference: `Condition/${cond2.id}`, display: htn.display }, priority: 'urgent', authoredOn: at })
  );
  const cat = encodeURIComponent('http://snomed.info/sct|3457005');
  const inbox = (org, status = 'active') => fhir(`ServiceRequest?performer=Organization/${org.id}&category=${cat}&status=${status}&_sort=-authored&_count=100`);
  check((await inbox(cardiology)).entry?.some((e) => e.resource.id === sr.id), 'referral visible in Cardiology inbox');
  check(!(await inbox(emergency)).entry?.some((e) => e.resource.id === sr.id), 'referral NOT visible in Emergency inbox');
  check(C.referralState(sr) === 'new', 'referral state new');
  let cur = await fhir(`ServiceRequest/${sr.id}`);
  cur = await fhir(`ServiceRequest/${sr.id}`, { method: 'PUT', body: C.acceptReferral(cur, me, new Date().toISOString()) });
  check(C.referralState(cur) === 'accepted', 'accept -> state accepted (practitioner appended to performer)');
  check((await inbox(cardiology)).entry?.some((e) => e.resource.id === sr.id), 'accepted referral still found by department performer search');
  cur = await fhir(`ServiceRequest/${sr.id}`, { method: 'PUT', body: C.completeReferral(cur, me, new Date().toISOString(), 'Seen, started amlodipine') });
  check(cur.status === 'completed', 'complete -> status completed');
  check(!(await inbox(cardiology)).entry?.some((e) => e.resource.id === sr.id), 'completed referral gone from open inbox');
  check((await inbox(cardiology, 'completed')).entry?.some((e) => e.resource.id === sr.id), 'completed referral in completed filter');
  const hist = await fhir(`ServiceRequest/${sr.id}/_history`);
  check(hist.entry.length === 3, `ServiceRequest has 3 versions (create/accept/complete), got ${hist.entry.length}`);
} catch (err) {
  failures++;
  console.error('ERROR', err);
} finally {
  // ---- cleanup: delete test data (reverse order), as admin ----
  const admin = await login('admin@example.com', 'medplum_admin');
  let deleted = 0;
  for (const r of created.reverse()) {
    try {
      await admin.fhir(r, { method: 'DELETE' });
      deleted++;
    } catch (e) {
      console.error('cleanup failed', r, String(e).slice(0, 200));
    }
  }
  console.log(`cleanup: deleted ${deleted}/${created.length} test resources`);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
