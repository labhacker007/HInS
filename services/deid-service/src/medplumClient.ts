/**
 * Server-side Medplum access for this service.
 *
 * Uses a real OAuth2 `client_credentials` grant against the HInS Dev
 * project's own `ClientApplication` — no human password embedded in a
 * service (closes the §16 gap this file used to document: "Self-hosted
 * Medplum's ClientApplication create/read API didn't return a `secret`
 * field when tried"). Re-verified live (2026-10-18) directly against this
 * instance: `GET /fhir/R4/ClientApplication/:id` with an admin bearer
 * token DOES return `secret` — the earlier attempt must have used a
 * different endpoint or admin-UI-only path; this was re-checked, not
 * assumed. `grant_type=client_credentials` against `/oauth2/token` then
 * resolves via `/auth/me` to `ClientApplication/:id` as the caller's own
 * profile — a real, non-human service identity.
 *
 * `MEDPLUM_SERVICE_CLIENT_ID`/`_SECRET` default to this project's seeded
 * dev client (`scripts/seed/` creates it) purely for local-dev
 * convenience, same pattern as every other dev-default credential in
 * this codebase — a real deployment sets these from a secret store.
 */
const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';
const CLIENT_ID = process.env.MEDPLUM_SERVICE_CLIENT_ID || '7e490c9a-62cd-402f-85e2-dc1e91bc62ec';
const CLIENT_SECRET =
  process.env.MEDPLUM_SERVICE_CLIENT_SECRET || 'dd062171cedf8cbc3f9fa2657146e48d77074962cdde9250fcf4140cf618f435';

let cachedToken: { accessToken: string; expiresAt: number } | undefined;

async function login(): Promise<string> {
  const token = await fetchJson(`${MEDPLUM_BASE_URL}/oauth2/token`, {
    method: 'POST',
    form: { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
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
