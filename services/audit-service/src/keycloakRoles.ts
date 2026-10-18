/**
 * Keycloak-backed role lookup for this service's admin-role check
 * (tenant_admin / compliance_officer) — replaces the Drizzle query
 * against `alert_subscriptions.role` that `activeRoleFor()` used to run
 * as the AUTHORIZATION source of truth (closes part of
 * docs/PLATFORM_BLUEPRINT.md §16's "no real Keycloak-integrated RBAC
 * yet" gap). `alert_subscriptions` ITSELF is unchanged by this file and
 * still used by `POST /events` for a different purpose — deciding who
 * gets an in-app notification on an edit — see index.ts's file header;
 * only its use as an authorization input is retired here. Duplicated
 * near-verbatim in services/deid-service/src/keycloakRoles.ts — see this
 * service's `resolveCaller()` header comment in index.ts for why these
 * two services duplicate their own auth-resolution code rather than
 * sharing a package.
 *
 * Scope, stated precisely: this file answers ONE question — "does this
 * already-identified Medplum Practitioner id have an admin role in
 * Keycloak, and if so which one?" It does NOT change how the caller's
 * identity itself is established — that is still Medplum's own
 * `GET /auth/me` (`resolveCaller()` in index.ts, unchanged). Medplum
 * login for practitioners/patients is completely unaffected by this
 * file; Keycloak is not an identity provider here, only a role-source
 * for these two services' own authorization checks.
 *
 * Seeded by scripts/seed/seed-keycloak-roles.mjs, which creates the
 * `hins-dev` realm, the two realm roles, the service-account client
 * this file authenticates as, and the per-practitioner Keycloak users
 * (keyed by Medplum Practitioner id as `username`, matching how
 * `alert_subscriptions.practitioner_id` was keyed) — run that script
 * once against a fresh Keycloak instance before this will find anyone.
 *
 * Service-account token caching mirrors
 * services/deid-service/src/medplumClient.ts's `getToken()` shape
 * (cache + early refresh, retry-once on a 401), not reinvented — but
 * Keycloak's client_credentials access tokens are short-lived (5 min by
 * default on this instance, verified live via the token response's own
 * `expires_in`, unlike Medplum's ~1h), so the cache uses the server's
 * own `expires_in` rather than a hardcoded assumption.
 *
 * FAIL CLOSED, on purpose, per this task's house rule: ANY failure
 * talking to Keycloak — unreachable host, timeout, non-2xx, a malformed
 * response — makes `activeRoleFromKeycloak()` return `undefined` ("no
 * role found"), the same outcome as a real "this practitioner has no
 * admin role" result. The caller sees a 403, never a 500 and never a
 * silent bypass to some other role source. The failure IS logged
 * server-side (via the `log` callback the caller passes in, typically
 * `app.log.error`) so an operator can tell "Keycloak is down" apart from
 * "really no role" in the logs — deliberately NOT surfaced as a
 * different HTTP status, since telling an unauthenticated/unauthorized
 * prober "the role service is down" vs. "you have no role" leaks
 * information about this service's own infrastructure for no benefit to
 * a legitimate caller (a legitimate admin caller during a real Keycloak
 * outage gets the same 403 as anyone else — a real, stated availability
 * trade-off of fail-closed design, not hidden).
 *
 * This file ALSO exports `keycloakAssignRole()`/`keycloakListRoleAssignments()`
 * — the write/list side used by `POST`/`GET /subscriptions` in index.ts,
 * which this service's admin endpoints repoint at Keycloak directly
 * (see this task's decision, recorded in index.ts's comment above those
 * routes and in this service's README) rather than leaving them as
 * no-op writes against a table `activeRoleFromKeycloak()` no longer
 * reads for authorization. Unlike the read-side role check above, these
 * are NOT fail-closed-to-undefined — they're only reachable from an
 * already-admin-authorized caller (gated by `requireAdminCaller`), so a
 * Keycloak write/list failure here is a real operational error and is
 * surfaced to that admin caller as one (502), not silently swallowed.
 */
const KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL ?? 'http://localhost:8080';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? 'hins-dev';
const SERVICE_CLIENT_ID = process.env.KEYCLOAK_SERVICE_CLIENT_ID ?? 'hins-rbac-service';
// Dev-default secret matches what scripts/seed/seed-keycloak-roles.mjs
// produces on a fresh seed of THIS repo's docker-compose Keycloak — same
// dev-default-credential convention used everywhere else in this
// codebase (e.g. medplumClient.ts's CLIENT_SECRET). A real deployment
// sets this from a secret store; re-running the seed script rotates it,
// so after a reseed this default may no longer match — set the env var
// explicitly if so.
const SERVICE_CLIENT_SECRET =
  process.env.KEYCLOAK_SERVICE_CLIENT_SECRET ??
  'NGqvBOqtouGxdBhHADWsQsMBTiFOqEKeCN3vZDu34g80dTeXDrvyPt2y0yoWxqRD7jXlRpCwZXbKGvchDhqg99';

/** Must match ADMIN_ROLES in index.ts — kept as a separate literal here
 * (not imported) so this file stays self-contained to read in isolation,
 * same spirit as this service duplicating rather than sharing
 * resolveCaller()-adjacent code with audit-service. */
const ADMIN_ROLES = ['tenant_admin', 'compliance_officer'] as const;

const FETCH_TIMEOUT_MS = 3000;

let cachedToken: { accessToken: string; expiresAt: number } | undefined;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loginServiceAccount(): Promise<{ accessToken: string; expiresInSec: number }> {
  const res = await fetchWithTimeout(`${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SERVICE_CLIENT_ID,
      client_secret: SERVICE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Keycloak token request -> ${res.status}: ${await res.text().catch(() => '')}`);
  const json: any = await res.json();
  return { accessToken: json.access_token, expiresInSec: json.expires_in ?? 60 };
}

async function getServiceToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  const { accessToken, expiresInSec } = await loginServiceAccount();
  // Refresh a bit early relative to Keycloak's own stated expiry rather
  // than a hardcoded guess (its client_credentials tokens are
  // short-lived — 300s by default on this instance, verified live,
  // nothing like Medplum's ~1h — so a fixed "50 minutes early" constant
  // copied from medplumClient.ts would be wrong here).
  cachedToken = { accessToken, expiresAt: Date.now() + Math.max(expiresInSec - 15, 5) * 1000 };
  return accessToken;
}

/** Shared request helper (GET/POST/etc.) against the Keycloak Admin REST
 * API, with the retry-once-on-401 pattern above. Returns the raw
 * Response so callers needing the `Location` header (user creation) or
 * an empty body (role-mapping writes) aren't forced through `.json()`. */
async function keycloakAdminRequest(path: string, init: RequestInit = {}): Promise<Response> {
  let token = await getServiceToken();
  const headers = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` };
  let res = await fetchWithTimeout(`${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}${path}`, { ...init, headers });
  if (res.status === 401) {
    cachedToken = undefined;
    token = await getServiceToken();
    res = await fetchWithTimeout(`${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}${path}`, {
      ...init,
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
  }
  return res;
}

async function keycloakAdminGet(path: string): Promise<any> {
  const res = await keycloakAdminRequest(path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

/**
 * Looks up `practitionerId`'s Keycloak realm-role names and returns the
 * first of tenant_admin/compliance_officer found — matching the return
 * shape of the `activeRoleFor()` function this replaces (a single role
 * string, or `undefined` for "no admin role"/"user not found"/"lookup
 * failed"). `log` is called (and the role lookup fails closed to
 * `undefined`) on ANY error — see this file's header for why that is
 * deliberate, not an oversight.
 */
export async function activeRoleFromKeycloak(
  practitionerId: string,
  log: (msg: string, err?: unknown) => void
): Promise<string | undefined> {
  try {
    const users = await keycloakAdminGet(`/users?username=${encodeURIComponent(practitionerId)}&exact=true`);
    const keycloakUserId: string | undefined = users?.[0]?.id;
    if (!keycloakUserId) return undefined; // no Keycloak user for this practitioner id -> no role, not an error

    const roles: Array<{ name: string }> = await keycloakAdminGet(`/users/${keycloakUserId}/role-mappings/realm`);
    const roleNames = new Set(roles.map((r) => r.name));
    return ADMIN_ROLES.find((r) => roleNames.has(r));
  } catch (err) {
    log(`Keycloak role lookup failed for practitioner ${practitionerId} — failing closed to "no role" (403, not 500/bypass)`, err);
    return undefined;
  }
}

/** Finds the Keycloak internal user id for a given Medplum Practitioner
 * id (the `username`), or creates the user (enabled, a throwaway
 * never-used password, same convention as
 * scripts/seed/seed-keycloak-roles.mjs) if none exists yet — so granting
 * a role to a practitioner who was never seeded into Keycloak still
 * works on first use. */
async function ensureKeycloakUser(practitionerId: string, practitionerName: string): Promise<string> {
  const existing = await keycloakAdminGet(`/users?username=${encodeURIComponent(practitionerId)}&exact=true`);
  const existingId: string | undefined = existing?.[0]?.id;
  if (existingId) return existingId;

  const res = await keycloakAdminRequest('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: practitionerId,
      enabled: true,
      firstName: practitionerName,
      credentials: [{ type: 'password', value: `unused-${practitionerId.slice(0, 8)}`, temporary: false }],
    }),
  });
  if (!res.ok) throw new Error(`POST /users -> ${res.status}: ${await res.text().catch(() => '')}`);
  const location = res.headers.get('location');
  const id = location?.split('/').filter(Boolean).pop();
  if (!id) throw new Error('Keycloak did not return a Location header for the created user.');
  return id;
}

/**
 * Write side of `POST /subscriptions` (index.ts): actually grants
 * `role` to `practitionerId`'s Keycloak user, creating that user first
 * if they don't exist yet. This is the real effect that used to be an
 * INSERT into `alert_subscriptions` — see this file's header and
 * index.ts's comment above the route for why that table stopped being
 * the authorization input and this now does the real work instead.
 * Throws on any Keycloak failure (NOT fail-closed-to-silent-success —
 * only `activeRoleFromKeycloak()`'s read-side check has that fail-closed
 * contract; a write that silently didn't happen would be a worse,
 * invisible gap than the one this service is closing).
 */
export async function keycloakAssignRole(practitionerId: string, practitionerName: string, role: string): Promise<void> {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
    throw new Error(`Unknown role "${role}" — must be one of ${ADMIN_ROLES.join(', ')}.`);
  }
  const userId = await ensureKeycloakUser(practitionerId, practitionerName);
  const roleRep = await keycloakAdminGet(`/roles/${encodeURIComponent(role)}`);
  const res = await keycloakAdminRequest(`/users/${userId}/role-mappings/realm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([roleRep]),
  });
  if (!res.ok) throw new Error(`POST role-mappings/realm -> ${res.status}: ${await res.text().catch(() => '')}`);
}

/**
 * Write side of `GET /subscriptions` (index.ts): lists every Keycloak
 * user currently holding `tenant_admin` or `compliance_officer`, in the
 * same shape the old `alert_subscriptions`-backed response had
 * (`practitionerId`/`practitionerName`/`role`) so apps/web or any other
 * caller of this endpoint doesn't need to change. Throws on failure, per
 * this file's header — same reasoning as `keycloakAssignRole()`.
 */
export async function keycloakListRoleAssignments(): Promise<
  Array<{ practitionerId: string; practitionerName: string; role: string }>
> {
  const results: Array<{ practitionerId: string; practitionerName: string; role: string }> = [];
  for (const role of ADMIN_ROLES) {
    const users: Array<{ username: string; firstName?: string }> = await keycloakAdminGet(
      `/roles/${encodeURIComponent(role)}/users`
    );
    for (const u of users) {
      results.push({ practitionerId: u.username, practitionerName: u.firstName ?? u.username, role });
    }
  }
  return results;
}
