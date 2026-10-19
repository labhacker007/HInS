/**
 * Keycloak-backed role lookup for this service's admin-role check
 * (tenant_admin / compliance_officer) — replaces the raw-SQL query
 * against `alert_subscriptions` that `activeRoleFor()` used to run as
 * the AUTHORIZATION source of truth (closes part of
 * docs/PLATFORM_BLUEPRINT.md §16's "no real Keycloak-integrated RBAC
 * yet" gap). Duplicated near-verbatim in
 * services/audit-service/src/keycloakRoles.ts — see this service's
 * `resolveCaller()` header comment in index.ts for why these two
 * services duplicate their own auth-resolution code rather than sharing
 * a package.
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
  process.env.KEYCLOAK_SERVICE_CLIENT_SECRET ||
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

async function keycloakAdminGet(path: string): Promise<any> {
  let token = await getServiceToken();
  let res = await fetchWithTimeout(`${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    cachedToken = undefined;
    token = await getServiceToken();
    res = await fetchWithTimeout(`${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }
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
