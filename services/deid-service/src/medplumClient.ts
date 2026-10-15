/**
 * Server-side Medplum access for this service.
 *
 * KNOWN GAP, not hidden: this reuses the same admin email/password +
 * PKCE login as scripts/seed/seed-demo-data.mjs, rather than a proper
 * OAuth2 client_credentials service identity. Medplum supports
 * client_credentials (docs/auth/methods/client-credentials) and it's the
 * architecturally correct choice for a backend service — no human
 * password embedded in a service. Self-hosted Medplum's ClientApplication
 * create/read API didn't return a `secret` field when tried during this
 * build (docs don't document where self-hosted exposes it outside the
 * admin UI), so this was deferred rather than block the feature on it.
 * Swap this module for a client_credentials flow once that's resolved —
 * tracked in docs/PLATFORM_BLUEPRINT.md §16.
 */
import { randomBytes, createHash } from 'node:crypto';

const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
const ADMIN_EMAIL = process.env.MEDPLUM_SERVICE_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.MEDPLUM_SERVICE_PASSWORD ?? 'medplum_admin';
const PROJECT_NAME = process.env.MEDPLUM_PROJECT_NAME ?? 'HInS Dev';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

let cachedToken: { accessToken: string; expiresAt: number } | undefined;

async function login(): Promise<string> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  let resp: any = await fetchJson(`${MEDPLUM_BASE_URL}/auth/login`, {
    method: 'POST',
    body: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      scope: 'openid',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    },
  });

  let code = resp.code;
  if (resp.memberships) {
    const membership = resp.memberships.find((m: any) => m.project.display === PROJECT_NAME);
    if (!membership) throw new Error(`deid-service: no membership in project "${PROJECT_NAME}"`);
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

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  const accessToken = await login();
  // Medplum access tokens are ~1h; refresh a bit early.
  cachedToken = { accessToken, expiresAt: Date.now() + 50 * 60 * 1000 };
  return accessToken;
}

async function fetchJson(url: string, opts: { method?: string; body?: unknown; form?: Record<string, string> } = {}): Promise<any> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(opts.form);
  } else if (opts.body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method: opts.method ?? 'GET', headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function fhirGet(path: string): Promise<any> {
  let token = await getToken();
  let res = await fetch(`${MEDPLUM_BASE_URL}/fhir/R4/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // Cached token expired server-side earlier than our local clock expected — retry once.
    cachedToken = undefined;
    token = await getToken();
    res = await fetch(`${MEDPLUM_BASE_URL}/fhir/R4/${path}`, { headers: { authorization: `Bearer ${token}` } });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
