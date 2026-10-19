/**
 * Tiny Medplum HTTP client shared by the RBAC seed scripts
 * (seed-access-policies.mjs, seed-staff.mjs). Plain fetch, no deps.
 */
import { randomBytes } from 'node:crypto';

export const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
export const PROJECT_ID = process.env.MEDPLUM_PROJECT_ID ?? '5dd648ca-aa1d-4828-a372-5021283afa46';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'medplum_admin';

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
