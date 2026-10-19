/**
 * Tiny Medplum HTTP client shared by the RBAC seed scripts
 * (seed-access-policies.mjs, seed-staff.mjs). Plain fetch, no deps.
 */
import '../lib/load-env.mjs';
import { randomBytes } from 'node:crypto';

export const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
/** "HInS Dev" project id — written to .env by `npm run bootstrap`. May be
 * undefined before bootstrap; login() then falls back to picking the
 * "HInS Dev" membership by name, which works for practitioner logins. */
export const PROJECT_ID = process.env.MEDPLUM_PROJECT_ID || undefined;
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'medplum_admin';
export const PATIENT_TEST_EMAIL = 'asha.verma.patient@example.com';

/** Returns { status, ok, json } — never throws on HTTP errors (callers decide). */
export async function request(path, { method = 'GET', body, form, token } = {}) {
  const headers = {};
  let payload;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form);
  } else if (body !== undefined) {
    headers['content-type'] = path.startsWith('/fhir/') ? 'application/fhir+json' : 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${MEDPLUM_BASE_URL}${path}`, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

/** Like request() but throws on non-2xx. */
export async function must(path, opts) {
  const r = await request(path, opts);
  if (!r.ok) throw new Error(`${opts?.method ?? 'GET'} ${path} -> ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}

/** PKCE-plain login. Picks the "HInS Dev" membership when the user has several. */
export async function login(email, password, projectId) {
  // /auth/login is rate-limited (5/window, shared across everything on this
  // host) — wait and retry instead of failing the seed.
  for (let attempt = 0; ; attempt++) {
    try {
      return await loginOnce(email, password, projectId);
    } catch (err) {
      if (attempt >= 10 || !String(err).includes('Too Many Requests')) throw err;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function loginOnce(email, password, projectId) {
  const verifier = randomBytes(32).toString('base64url');
  let resp = await must('/auth/login', {
    method: 'POST',
    body: { email, password, codeChallengeMethod: 'plain', codeChallenge: verifier, projectId },
  });
  let code = resp.code;
  if (resp.memberships) {
    const m = resp.memberships.find((x) => x.project?.display === 'HInS Dev') ?? resp.memberships[0];
    resp = await must('/auth/profile', { method: 'POST', body: { login: resp.login, profile: m.id } });
    code = resp.code;
  }
  const t = await must('/oauth2/token', {
    method: 'POST',
    form: { grant_type: 'authorization_code', code, code_verifier: verifier },
  });
  return t.access_token;
}

export const adminLogin = () => login(ADMIN_EMAIL, ADMIN_PASSWORD);

export async function searchOne(token, resourceType, params) {
  const qs = new URLSearchParams(params).toString();
  const b = await must(`/fhir/R4/${resourceType}?${qs}`, { token });
  return b.entry?.[0]?.resource;
}

/** The ProjectMembership (in the token's project) whose User has this email. */
export async function membershipByEmail(token, email) {
  const b = await must('/fhir/R4/ProjectMembership?_count=1000', { token });
  return (b.entry ?? [])
    .map((e) => e.resource)
    .find((m) => m.user?.display?.toLowerCase() === email.toLowerCase());
}

/** Bare id of the profile (Patient/Practitioner) for a login email, or undefined. */
export async function profileIdByEmail(token, email) {
  return (await membershipByEmail(token, email))?.profile?.reference?.split('/')[1];
}

/** Asha Verma's Patient id — the patient test login's own profile. Looked
 * up live (or HINS_DEMO_PATIENT_ID) instead of hardcoding one machine's id. */
export async function demoPatientId(token) {
  if (process.env.HINS_DEMO_PATIENT_ID) return process.env.HINS_DEMO_PATIENT_ID;
  const id = await profileIdByEmail(token ?? (await adminLogin()), PATIENT_TEST_EMAIL);
  if (!id) throw new Error(`No ${PATIENT_TEST_EMAIL} login in HInS Dev — run \`npm run bootstrap\` first`);
  return id;
}

/** The token owner's own profile + project, via GET /auth/me. */
export async function whoAmI(token) {
  const me = await must('/auth/me', { token });
  return {
    profileId: me.profile?.id,
    profileType: me.profile?.resourceType,
    projectId: me.project?.id ?? me.membership?.project?.reference?.split('/')[1],
  };
}
