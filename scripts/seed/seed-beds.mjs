#!/usr/bin/env node
/**
 * Seeds Location resources for bed/ward management (BedBoard.tsx,
 * docs/PLATFORM_BLUEPRINT.md §13/§13a's "bed/ward" roadmap item) so the
 * feature is demoable against something more than an empty census.
 *
 * Mirrors scripts/seed/seed-demo-data.mjs's style: plain Node, fetch-
 * based against Medplum's FHIR API directly, clear console.log progress.
 * Unlike that script, and LIKE seed-keycloak-roles.mjs, this one IS
 * idempotent -- safe to re-run any number of times. Idempotency check:
 * before creating a ward or bed Location, search for an existing one
 * with the same `name` (Location.name has no uniqueness constraint in
 * FHIR/Medplum, so this script enforces it itself, the same tradeoff
 * seed-keycloak-roles.mjs makes for its own idempotency checks).
 *
 * Creates 2 wards x 4 beds = 8 Location resources:
 *   - "General Ward A" -> beds "General Ward A — Bed 1".."Bed 4"
 *   - "ICU"             -> beds "ICU — Bed 1".."Bed 4"
 *
 * Usage:
 *   node scripts/seed/seed-beds.mjs
 *
 * Env overrides (defaults match infra/docker-compose.yml):
 *   MEDPLUM_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, MEDPLUM_PROJECT_ID
 */
import '../lib/load-env.mjs';
import { randomBytes } from 'node:crypto';

const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'medplum_admin';
// admin@example.com is a server-level super-admin with multiple project
// memberships and works with NO projectId in /auth/login -- see this
// script's login() below, same approach seed-demo-data.mjs uses.

const LOCATION_PHYSICAL_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/location-physical-type';

const WARDS = [
  { name: 'General Ward A', bedCount: 4 },
  { name: 'ICU', bedCount: 4 },
];

function b64url(buf) {
  return buf.toString('base64url');
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

/** Email/password login against Medplum's PKCE-based /auth flow. Mirrors
 * seed-demo-data.mjs's login(), with the admin@example.com no-projectId
 * shortcut this project's super-admin account supports. */
async function login(email, password) {
  const verifier = b64url(randomBytes(32));
  let resp = await fetchJson(`${MEDPLUM_BASE_URL}/auth/login`, {
    method: 'POST',
    body: { email, password, codeChallengeMethod: 'plain', codeChallenge: verifier },
  });

  let code = resp.code;
  if (resp.memberships) {
    const membership = resp.memberships.find((m) => m.project.display === 'HInS Dev') ?? resp.memberships[0];
    resp = await fetchJson(`${MEDPLUM_BASE_URL}/auth/profile`, {
      method: 'POST',
      body: { login: resp.login, profile: membership.id },
    });
    code = resp.code;
  }

  const token = await fetchJson(`${MEDPLUM_BASE_URL}/oauth2/token`, {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, code_verifier: verifier },
  });
  return token.access_token;
}

function fhir(token) {
  const base = `${MEDPLUM_BASE_URL}/fhir/R4`;
  return {
    findByName: async (name) => {
      const result = await fetchJson(`${base}/Location?name=${encodeURIComponent(name)}&_count=5`, { token });
      // FHIR's `name` search param is a partial/token match in general,
      // so narrow to an exact match client-side rather than trusting the
      // server filtered precisely -- same caution this task's own
      // occupancy-check design applies to the `location` search param.
      return (result.entry ?? []).map((e) => e.resource).find((loc) => loc.name === name);
    },
    create: (resource) => fetchJson(`${base}/Location`, { method: 'POST', body: resource, token }),
  };
}

async function main() {
  console.log('Logging in as admin...');
  const token = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const F = fhir(token);

  for (const ward of WARDS) {
    let wardLocation = await F.findByName(ward.name);
    if (wardLocation) {
      console.log(`Ward "${ward.name}" already exists (Location/${wardLocation.id}), skipping create.`);
    } else {
      wardLocation = await F.create({
        resourceType: 'Location',
        name: ward.name,
        status: 'active',
        physicalType: { coding: [{ system: LOCATION_PHYSICAL_TYPE_SYSTEM, code: 'wa', display: 'Ward' }] },
      });
      console.log(`Created ward "${ward.name}" -> Location/${wardLocation.id}`);
    }

    for (let i = 1; i <= ward.bedCount; i++) {
      const bedName = `${ward.name} — Bed ${i}`;
      const existingBed = await F.findByName(bedName);
      if (existingBed) {
        console.log(`  Bed "${bedName}" already exists (Location/${existingBed.id}), skipping create.`);
        continue;
      }
      const bedLocation = await F.create({
        resourceType: 'Location',
        name: bedName,
        status: 'active',
        physicalType: { coding: [{ system: LOCATION_PHYSICAL_TYPE_SYSTEM, code: 'bd', display: 'Bed' }] },
        partOf: { reference: `Location/${wardLocation.id}` },
      });
      console.log(`  Created bed "${bedName}" -> Location/${bedLocation.id}`);
    }
  }

  console.log('\nDone. BedBoard.tsx (apps/web) will show these wards/beds in its census view.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
