#!/usr/bin/env node
/**
 * End-to-end cross-department check with real role logins (server-side
 * AccessPolicies in force): physician orders a lab test -> lab tech sees it,
 * uploads a lab-report document (category from lib/access.ts docCategory) and
 * a preliminary DiagnosticReport -> pathologist finalizes -> physician reads
 * the final report; billing staff cannot read the report document.
 * Request shapes mirror apps/web/src/lib/diagnostics.ts. Cleans up after.
 *
 * Usage: node scripts/verify/verify-cross-department.mjs
 */
import { request, must, login, adminLogin, PROJECT_ID } from '../seed/_medplum-client.mjs';

const PATIENT = 'Patient/590f0356-27a0-4ead-ada2-20f9f27987a1';
const DEPT = 'https://hins.example/fhir/department';
const DOC_CAT = { coding: [{ system: 'https://hins.example/fhir/document-category', code: 'lab-report', display: 'Lab report' }] };
const created = [];
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -> ${detail}` : ''}`);
};

const [admin, doc, lab, path, billing] = [
  await adminLogin(),
  await login('dr.sharma@stjones.example', 'DrSharma123!', PROJECT_ID),
  await login('lab.tech@stjones.example', 'Staff123!', PROJECT_ID),
  await login('pathologist@stjones.example', 'Staff123!', PROJECT_ID),
  await login('billing@stjones.example', 'Staff123!', PROJECT_ID),
];

try {
  const labOrg = (await must(`/fhir/R4/Organization?identifier=${encodeURIComponent(`${DEPT}|laboratory`)}`, { token: admin })).entry[0].resource;

  // 1. Physician orders a CBC to the Laboratory department.
  const sr = await request('/fhir/R4/ServiceRequest', {
    method: 'POST', token: doc,
    body: {
      resourceType: 'ServiceRequest', status: 'active', intent: 'order', priority: 'urgent',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '58410-2', display: 'CBC panel - Blood by Automated count' }] },
      subject: { reference: PATIENT }, performer: [{ reference: `Organization/${labOrg.id}` }],
    },
  });
  check(sr.status === 201, 'physician creates lab ServiceRequest', sr.status);
  created.push(`ServiceRequest/${sr.json.id}`);

  // 2. Lab tech sees it in the Laboratory queue.
  const q = await request(`/fhir/R4/ServiceRequest?performer=Organization/${labOrg.id}&status=active`, { token: lab });
  check(q.status === 200 && (q.json.entry ?? []).some((e) => e.resource.id === sr.json.id), 'lab tech sees order in Laboratory queue', q.status);

  // 3. Lab tech uploads a lab-report document (the category fix) + preliminary report.
  const dr = await request('/fhir/R4/DocumentReference', {
    method: 'POST', token: lab,
    body: {
      resourceType: 'DocumentReference', status: 'current', type: { text: 'Laboratory result document' }, category: [DOC_CAT],
      subject: { reference: PATIENT }, content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('CBC: Hb 13.1 g/dL').toString('base64'), title: 'cbc.txt' } }],
      context: { related: [{ reference: `ServiceRequest/${sr.json.id}` }] },
    },
  });
  check(dr.status === 201, 'lab tech uploads categorized lab-report document', dr.status);
  created.push(`DocumentReference/${dr.json.id}`);
  const readBack = await request(`/fhir/R4/DocumentReference/${dr.json.id}`, { token: lab });
  check(readBack.status === 200, 'lab tech can read back its own lab-report document', readBack.status);

  const rep = await request('/fhir/R4/DiagnosticReport', {
    method: 'POST', token: lab,
    body: {
      resourceType: 'DiagnosticReport', status: 'preliminary', basedOn: [{ reference: `ServiceRequest/${sr.json.id}` }],
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '58410-2' }] }, subject: { reference: PATIENT },
    },
  });
  check(rep.status === 201, 'lab tech creates preliminary DiagnosticReport', rep.status);
  created.push(`DiagnosticReport/${rep.json.id}`);

  // 4. Pathologist finalizes.
  const fin = await request(`/fhir/R4/DiagnosticReport/${rep.json.id}`, {
    method: 'PUT', token: path,
    body: { ...rep.json, status: 'final', conclusion: 'Within normal limits.' },
  });
  check(fin.status === 200 && fin.json.status === 'final', 'pathologist signs report final', fin.status);

  // 5. Physician sees the final report; billing cannot read the lab document.
  const seen = await request(`/fhir/R4/DiagnosticReport/${rep.json.id}`, { token: doc });
  check(seen.status === 200 && seen.json.status === 'final', 'physician reads final report', seen.status);
  const bill = await request(`/fhir/R4/DocumentReference/${dr.json.id}`, { token: billing });
  check(bill.status === 403 || bill.status === 404, 'billing staff denied lab document', bill.status);
} finally {
  for (const ref of created.reverse()) await request(`/fhir/R4/${ref}`, { method: 'DELETE', token: admin });
  console.log(`cleanup: deleted ${created.length} test resources`);
}
console.log(failures ? `${failures} FAILED` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
