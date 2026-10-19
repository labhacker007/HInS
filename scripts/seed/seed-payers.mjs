#!/usr/bin/env node
/**
 * Seeds `Organization` resources representing insurance payers for the
 * US-path billing/RCM feature (apps/web/src/pages/clinician/Billing.tsx,
 * docs/PLATFORM_BLUEPRINT.md §13/§13a's "03 — Financial & admin" roadmap
 * item) so the Coverage panel's payer dropdown isn't empty on first use.
 *
 * Mirrors scripts/seed/seed-beds.mjs's style and structure exactly: plain
 * Node, fetch-based against Medplum's FHIR API directly, idempotent
 * (safe to re-run any number of times -- checks by `name` before
 * creating, same tradeoff seed-beds.mjs documents for Location.name
 * having no uniqueness constraint in FHIR/Medplum).
 *
 * These are real, named entities (same category as the existing seeded
 * Practitioner/Patient test data) -- not fabricated billing codes.
 *
 * US-domiciled payers only, deliberately (fixed post-review, 2026-10-19):
 * an earlier version of this script also seeded an India-domiciled payer
 * to match this platform's dual-jurisdiction framing, but Billing.tsx
 * hardcodes every money field (ChargeItem.priceOverride, Claim.total,
 * PaymentReconciliation.paymentAmount) to `currency: 'USD'` -- a clinician
 * could pick that payer for a Coverage and every charge/claim/payment
 * against it would be silently denominated in USD. Dropped until the
 * India path (NHCX, a separate, unbuilt roadmap item, §13a) is actually
 * built with its own currency handling, rather than leave a payer in the
 * dropdown that quietly produces wrong-currency billing today.
 *
 * Usage:
 *   node scripts/seed/seed-payers.mjs
 *
 * Env overrides (defaults match infra/docker-compose.yml):
 *   MEDPLUM_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 */
import { randomBytes } from 'node:crypto';

const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'medplum_admin';
// admin@example.com is a server-level super-admin with multiple project
// memberships and works with NO projectId in /auth/login -- see login()
// below, same approach seed-beds.mjs/seed-demo-data.mjs use.

const ORG_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/organization-type';

const PAYERS = [
  { name: 'Aetna', country: 'US' },
  { name: 'UnitedHealthcare', country: 'US' },
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
 * seed-beds.mjs's login() verbatim. */
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
      const result = await fetchJson(`${base}/Organization?name=${encodeURIComponent(name)}&_count=5`, { token });
      // `name` is a partial/token match in general FHIR search semantics
      // -- narrow to an exact match client-side, same caution seed-beds.mjs
      // applies to Location.name.
      return (result.entry ?? []).map((e) => e.resource).find((org) => org.name === name);
    },
    create: (resource) => fetchJson(`${base}/Organization`, { method: 'POST', body: resource, token }),
  };
}

async function main() {
  console.log('Logging in as admin...');
  const token = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const F = fhir(token);

  for (const payer of PAYERS) {
    const existing = await F.findByName(payer.name);
    if (existing) {
      console.log(`Payer "${payer.name}" already exists (Organization/${existing.id}), skipping create.`);
      continue;
    }
    const org = await F.create({
      resourceType: 'Organization',
      active: true,
      name: payer.name,
      // 'ins' (Insurance Company) is a real, structural HL7 code from the
      // organization-type CodeSystem -- not a fabricated billing code.
      // Used so Billing.tsx's payer dropdown can query
      // Organization?type=...|ins rather than listing every Organization
      // in the project (which may later include hospitals/departments).
      type: [{ coding: [{ system: ORG_TYPE_SYSTEM, code: 'ins', display: 'Insurance Company' }] }],
      address: [{ country: payer.country }],
    });
    console.log(`Created payer "${payer.name}" -> Organization/${org.id}`);
  }

  console.log('\nDone. Billing.tsx (apps/web, /billing) will show these payers in its Coverage panel.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
