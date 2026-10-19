#!/usr/bin/env node
/**
 * Seeds demo staff logins, one per key role, each with:
 *   - a ProjectMembership in "HInS Dev" whose accessPolicy is the role's
 *     "HInS role: <code>" policy (server-side enforcement), and
 *   - a PractitionerRole (organization = department Organization,
 *     code = ROLE_SYSTEM|role, active = true) — the department/role record
 *     the app displays and that future work queues scope by.
 * Also gives dr.sharma a physician @ cardiology PractitionerRole WITHOUT
 * touching her membership/access policy (she keeps Medplum's Default
 * Practitioner Access Policy, so nothing she could do before breaks).
 *
 * Idempotent: existing members are matched by email; their access policy /
 * admin flag is re-synced, and the PractitionerRole is reused if one with
 * the same role code + department already exists (re-activated if needed).
 *
 * Prereqs: seed-departments.mjs and seed-access-policies.mjs have run.
 * Usage: node scripts/seed/seed-staff.mjs
 *
 * Known gap, stated plainly: passwords are fixed demo values (Staff123!)
 * set via the invite API — dev only. A real deployment invites by email and
 * lets the person set their own password, with MFA.
 */
import { PROJECT_ID, adminLogin, must, request, searchOne } from './_medplum-client.mjs';

// Must match apps/web/src/lib/hospital.ts / access.ts
const DEPT_SYSTEM = 'https://hins.example/fhir/department';
const ROLE_SYSTEM = 'https://hins.example/fhir/staff-role';
const POLICY_PREFIX = 'HInS role: ';
const PASSWORD = 'Staff123!';

const STAFF = [
  { email: 'lab.tech@stjones.example', given: 'Ravi', family: 'Kumar', role: 'lab-technician', dept: 'laboratory' },
  { email: 'pathologist@stjones.example', given: 'Anil', family: 'Desai', role: 'pathologist', dept: 'laboratory' },
  { email: 'radiologist@stjones.example', given: 'Meera', family: 'Iyer', role: 'radiologist', dept: 'radiology' },
  { email: 'pharmacist@stjones.example', given: 'Arjun', family: 'Mehta', role: 'pharmacist', dept: 'pharmacy' },
  { email: 'billing@stjones.example', given: 'Neha', family: 'Gupta', role: 'billing-staff', dept: 'billing' },
  { email: 'triage.nurse@stjones.example', given: 'Sunita', family: 'Rao', role: 'triage-nurse', dept: 'emergency' },
  { email: 'dietitian@stjones.example', given: 'Kavya', family: 'Nair', role: 'dietitian', dept: 'nutrition' },
  { email: 'hospital.admin@stjones.example', given: 'Vikram', family: 'Singh', role: 'hospital-admin', dept: 'administration' },
];
const ROLE_DISPLAY = {
  'lab-technician': 'Lab Technician', radiologist: 'Radiologist', pharmacist: 'Pharmacist',
  'billing-staff': 'Billing Staff', 'triage-nurse': 'Triage Nurse', dietitian: 'Dietitian',
  'hospital-admin': 'Hospital Admin', physician: 'Physician',
};

const token = await adminLogin();

const policyCache = new Map();
async function policyFor(role) {
  if (!policyCache.has(role)) {
    const name = `${POLICY_PREFIX}${role}`;
    const b = await must(`/fhir/R4/AccessPolicy?name=${encodeURIComponent(name)}`, { token });
    const p = (b.entry ?? []).map((e) => e.resource).find((x) => x.name === name);
    if (!p) throw new Error(`Missing AccessPolicy "${name}" — run seed-access-policies.mjs first`);
    policyCache.set(role, p);
  }
  return policyCache.get(role);
}

async function deptOrg(code) {
  const org = await searchOne(token, 'Organization', { identifier: `${DEPT_SYSTEM}|${code}` });
  if (!org) throw new Error(`Missing department Organization "${code}" — run seed-departments.mjs first`);
  return org;
}

const members = (await must('/fhir/R4/ProjectMembership?_count=1000', { token })).entry?.map((e) => e.resource) ?? [];
const memberByEmail = (email) => members.find((m) => m.user?.display?.toLowerCase() === email.toLowerCase());

async function ensureMember(s) {
  const policy = await policyFor(s.role);
  const admin = s.role === 'hospital-admin';
  const policyRef = { reference: `AccessPolicy/${policy.id}`, display: policy.name };
  let m = memberByEmail(s.email);
  if (!m) {
    m = await must(`/admin/projects/${PROJECT_ID}/invite`, {
      method: 'POST',
      token,
      body: {
        resourceType: 'Practitioner',
        firstName: s.given,
        lastName: s.family,
        email: s.email,
        password: PASSWORD,
        sendEmail: false,
        membership: { accessPolicy: policyRef, admin },
      },
    });
    console.log(`  invited: ${s.email} -> ${m.profile.reference}`);
  } else if (m.accessPolicy?.reference !== policyRef.reference || Boolean(m.admin) !== admin) {
    m = await must(`/fhir/R4/ProjectMembership/${m.id}`, { method: 'PUT', token, body: { ...m, accessPolicy: policyRef, admin } });
    console.log(`  re-synced membership: ${s.email}`);
  } else {
    console.log(`  exists:  ${s.email} (${m.profile.reference})`);
  }
  return m;
}

async function ensureRole(practitionerRef, role, deptCode) {
  const org = await deptOrg(deptCode);
  const b = await must(`/fhir/R4/PractitionerRole?practitioner=${practitionerRef.reference}&_count=100`, { token });
  const existing = (b.entry ?? [])
    .map((e) => e.resource)
    .find(
      (r) =>
        r.organization?.reference === `Organization/${org.id}` &&
        r.code?.some((c) => c.coding?.some((cd) => cd.system === ROLE_SYSTEM && cd.code === role)),
    );
  if (existing) {
    if (existing.active === false) {
      await must(`/fhir/R4/PractitionerRole/${existing.id}`, { method: 'PUT', token, body: { ...existing, active: true } });
      console.log(`    re-activated PractitionerRole/${existing.id}`);
    } else {
      console.log(`    role exists: ${role} @ ${deptCode} (PractitionerRole/${existing.id})`);
    }
    return;
  }
  const created = await must('/fhir/R4/PractitionerRole', {
    method: 'POST',
    token,
    body: {
      resourceType: 'PractitionerRole',
      active: true,
      period: { start: new Date().toISOString().slice(0, 10) },
      practitioner: practitionerRef,
      organization: { reference: `Organization/${org.id}`, display: org.name },
      code: [{ coding: [{ system: ROLE_SYSTEM, code: role, display: ROLE_DISPLAY[role] ?? role }], text: ROLE_DISPLAY[role] ?? role }],
    },
  });
  console.log(`    role created: ${role} @ ${deptCode} (PractitionerRole/${created.id})`);
}

console.log('Staff:');
for (const s of STAFF) {
  const m = await ensureMember(s);
  await ensureRole(m.profile, s.role, s.dept);
}

console.log('Dr. Sharma (PractitionerRole only; access policy untouched):');
const sharma = memberByEmail('dr.sharma@stjones.example');
if (!sharma) throw new Error('dr.sharma not found — run seed-demo-data.mjs first');
await ensureRole(sharma.profile, 'physician', 'cardiology');

const check = await request(`/fhir/R4/ProjectMembership/${sharma.id}`, { token });
console.log(`    dr.sharma accessPolicy still: ${check.json.accessPolicy?.display}`);
console.log(`Done. Demo password for all seeded staff: ${PASSWORD}`);
