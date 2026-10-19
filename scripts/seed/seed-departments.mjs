#!/usr/bin/env node
/**
 * Seeds the hospital Organization and one Organization per department
 * (partOf the hospital), idempotent by identifier. Department codes MUST
 * match apps/web/src/lib/hospital.ts DEPARTMENTS — that file is the source
 * of truth; keep this list in sync with it.
 *
 * Usage: node scripts/seed/seed-departments.mjs
 */
import { randomBytes } from 'node:crypto';

const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'medplum_admin';
const DEPT_SYSTEM = 'https://hins.example/fhir/department';

const HOSPITAL = { code: 'st-jones', name: 'St. Jones Multi-Specialty Hospital' };
const DEPARTMENTS = [
  ['emergency', 'Emergency'],
  ['general-medicine', 'General Medicine (OPD)'],
  ['cardiology', 'Cardiology'],
  ['pediatrics', 'Pediatrics'],
  ['inpatient-ward', 'Inpatient Wards'],
  ['laboratory', 'Laboratory'],
  ['radiology', 'Radiology'],
  ['pharmacy', 'Pharmacy'],
  ['nutrition', 'Nutrition & Dietetics'],
  ['billing', 'Billing & Insurance'],
  ['administration', 'Administration'],
];

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
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function login(email, password) {
  const verifier = randomBytes(32).toString('base64url');
  let resp = await fetchJson(`${MEDPLUM_BASE_URL}/auth/login`, {
    method: 'POST',
    body: { email, password, codeChallengeMethod: 'plain', codeChallenge: verifier },
  });
  let code = resp.code;
  if (resp.memberships) {
    const m = resp.memberships.find((x) => x.project.display === 'HInS Dev') ?? resp.memberships[0];
    resp = await fetchJson(`${MEDPLUM_BASE_URL}/auth/profile`, { method: 'POST', body: { login: resp.login, profile: m.id } });
    code = resp.code;
  }
  const t = await fetchJson(`${MEDPLUM_BASE_URL}/oauth2/token`, {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, code_verifier: verifier },
  });
  return t.access_token;
}

async function upsertOrg(token, code, name, partOf) {
  const base = `${MEDPLUM_BASE_URL}/fhir/R4/Organization`;
  const found = await fetchJson(`${base}?identifier=${encodeURIComponent(`${DEPT_SYSTEM}|${code}`)}`, { token });
  const existing = found.entry?.[0]?.resource;
  if (existing) {
    console.log(`  exists: ${name} (Organization/${existing.id})`);
    return existing;
  }
  const created = await fetchJson(base, {
    method: 'POST',
    token,
    body: {
      resourceType: 'Organization',
      active: true,
      identifier: [{ system: DEPT_SYSTEM, value: code }],
      name,
      type: [{ text: partOf ? 'Hospital department' : 'Hospital' }],
      partOf: partOf ? { reference: `Organization/${partOf.id}`, display: partOf.name } : undefined,
    },
  });
  console.log(`  created: ${name} (Organization/${created.id})`);
  return created;
}

const token = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
console.log('Hospital:');
const hospital = await upsertOrg(token, HOSPITAL.code, HOSPITAL.name);
console.log('Departments:');
for (const [code, name] of DEPARTMENTS) await upsertOrg(token, code, name, hospital);
console.log('Done.');
