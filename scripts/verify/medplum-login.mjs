/** Tiny Medplum PKCE login + FHIR fetch helper for verification scripts. */
import { randomBytes } from 'node:crypto';
export const BASE = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
export const PROJECT_ID = process.env.MEDPLUM_PROJECT_ID ?? '5dd648ca-aa1d-4828-a372-5021283afa46';

async function j(url, opts, tries = 4) {
  const res = await fetch(url, opts);
  if (res.status === 429 && tries > 0) {
    // Auth endpoints are rate-limited (5/min); wait for the reset and retry.
    const body = await res.json().catch(() => ({}));
    const wait = (body.extension?.[0]?.valueUnsignedInt ?? 30) * 1000 + 1000;
    console.error(`rate-limited, waiting ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
    return j(url, opts, tries - 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts?.method ?? 'GET'} ${url} -> ${res.status}: ${JSON.stringify(body).slice(0, 600)}`);
  return body;
}

export async function login(email, password, { projectId } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  let r = await j(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, codeChallengeMethod: 'plain', codeChallenge: verifier, ...(projectId ? { projectId } : {}) }),
  });
  if (r.memberships) {
    const m = r.memberships.find((x) => x.project?.display === 'HInS Dev') ?? r.memberships[0];
    r = await j(`${BASE}/auth/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: r.login, profile: m.id }) });
  }
  const t = await j(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: r.code, code_verifier: verifier }),
  });
  const token = t.access_token;
  const fhir = (path, { method = 'GET', body } = {}) =>
    j(`${BASE}/fhir/R4/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/fhir+json' } : {}), 'cache-control': 'no-cache' },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { token, fhir, profile: t.profile };
}
