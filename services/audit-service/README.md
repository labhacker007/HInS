# audit-service — edit audit trail + role-based alerting

docs/PLATFORM_BLUEPRINT.md §06/§09's "Audit & Logging" cross-cutting
service, built for clinical-resource edits specifically (notes and
prescriptions today) — not yet every PHI read/write §09 eventually
describes.

## What it does

`POST /events` records who changed what, when (`edit_events`), then fans
out in-app alerts (`notifications`) to two kinds of recipient:

1. **Role subscribers** — everyone in `alert_subscriptions`, minus
   whoever made the edit. Seeded by `scripts/seed/` (Medplum Admin as
   `tenant_admin`, Alex Fernandes as `compliance_officer` — a stand-in
   for "security team").
2. **The original author**, if someone else made the edit — so a
   clinician is told when another clinician corrects their note or
   prescription, even if they're not a subscribed role.

`apps/web`'s clinician header has a notification bell (🔔, polling every
20s) showing unread alerts, who made the change, and why they were
notified ("subscribed role" vs. "you authored this").

## What "alerting" does and doesn't mean here

**In-app notifications only.** No email, SMS, or pager integration —
that's a real gap for actual clinical alerting (a missed-correction alert
that only shows up if someone happens to have the app open isn't much of
an alert), not a design choice to treat as finished.

**`alert_subscriptions` is a placeholder for real role-derived alerting
— and, as of 2026-10-18, deliberately NOT the same thing as this
service's admin-role access control anymore.** This table still decides
who gets notified on an edit, seeded by hand; it is no longer read for
authorization at all (see "What's still NOT real RBAC" below) — that now
comes from a real Keycloak realm. These were conflated before (one table
served both "who's an admin" and "who gets notified"); they're now two
separate concerns, which is more honest but means granting a Keycloak
admin role does NOT by itself add someone as a notification subscriber.
A real deployment still needs notification-subscription itself driven
by an actual role/preference system rather than a hand-seeded list —
that part of the original gap is still open, just no longer entangled
with access control.

**`GET`/`POST /subscriptions` and `GET /notifications` are now access-
controlled, closing the gap this README used to state plainly
(2026-10-15 → 2026-10-18 update):**

- `GET`/`POST /subscriptions` require `Authorization: Bearer <token>`
  for a real Medplum caller on this project — resolved via Medplum's own
  `GET /auth/me` (not a locally-decoded JWT; see `src/index.ts`'s
  `resolveCaller` header comment for what was actually tried and ruled
  out against the live instance first, including why a naive "forward
  the token to `GET /fhir/R4/Practitioner/{claimedId}`" check turned out
  to be spoofable on this instance's default access policy) — AND that
  caller must hold a `tenant_admin` or `compliance_officer` role (as of
  2026-10-18, from a real Keycloak realm — see below — originally from
  an active `alert_subscriptions` row before that update). No token →
  401; valid token, wrong role → 403 naming the roles required.
- `GET /notifications?recipientId=X` now additionally confirms the
  resolved caller's own practitioner id matches `recipientId` — a
  non-admin caller can only read their OWN notifications now, not
  anyone else's by putting a different id in the query string. A caller
  with an active `tenant_admin`/`compliance_officer` subscription may
  still read anyone's (e.g. for an admin dashboard). This was the exact
  gap this README used to call out ("currently only scoped by the
  recipientId query param with no proof the caller IS that recipient").
- `POST /notifications/:id/read` and `POST /notifications/read-all` now
  apply the exact same self-or-admin check (2026-10-18 update, closing
  the gap this README used to call out below): the caller must be the
  notification's own recipient, or hold an active `tenant_admin`/
  `compliance_officer` subscription to mark someone else's read. For
  `:id/read`, the row is fetched first to learn its `recipientId` (the
  `:id` path param alone doesn't say who owns it) — 404 if no
  notification exists with that id, 401 with no/invalid token, 403 if
  the caller is neither the recipient nor an admin. `read-all` checks
  the same thing against the body's `recipientId` instead.

**Role source of truth is now a real Keycloak realm, not the hand-seeded
table (2026-10-18 update):** every admin-role check in this service
(`GET`/`POST /subscriptions`, the admin branch of `GET /notifications`)
now looks the caller's Practitioner id up in a real Keycloak realm
(`hins-dev`, at `KEYCLOAK_BASE_URL`, default `http://localhost:8080`)
via the Keycloak Admin REST API, instead of a row in
`alert_subscriptions`. See `src/keycloakRoles.ts`'s file header for the
full design — a confidential client with a service account inside
`hins-dev`, calling Keycloak's Admin API via `client_credentials`,
granted the built-in `realm-management` client's `view-users`,
`query-users`, `view-realm`, and `manage-users` roles (the standard
self-realm-management pattern; the exact 4-role set was found
**empirically** against this live instance, not guessed — see
`scripts/seed/seed-keycloak-roles.mjs`'s header). Seeded by that same
script, which also creates the two realm roles and the two practitioner
users (keyed by Medplum Practitioner id as `username`). **Fails closed**:
a Keycloak outage/timeout/error makes the role lookup return "no role"
(403), never a 500 and never a silent fallback to the old table —
verified live by pointing a test instance's `KEYCLOAK_BASE_URL` at an
unreachable port and confirming an otherwise-valid admin token got 403.

**`GET`/`POST /subscriptions` now do REAL work against Keycloak, not a
no-op** (the decision this task had to make, stated plainly): once
`activeRoleFor()` stopped reading `alert_subscriptions.role` for
authorization, leaving these two endpoints as plain
INSERT/SELECT against that table would have been actively deceptive —
an admin calling `POST /subscriptions` would believe they'd just granted
a role, and nothing would actually change. Chosen fix: repoint both at
the Keycloak Admin REST API directly (`keycloakAssignRole`/
`keycloakListRoleAssignments` in `src/keycloakRoles.ts`), fully retiring
`alert_subscriptions.role` as an authorization input, rather than the
alternative of marking them `410 Gone`. **`alert_subscriptions` the
TABLE is unchanged and still used** by `POST /events` for its own,
separate purpose — deciding who gets an in-app notification on an edit
— that's a different concern read from the same table for a different
reason, not touched by this change. One real behavior change worth
calling out: granting an admin role via `POST /subscriptions` used to
ALSO add that practitioner as a notification subscriber as a side
effect (same row, same table). That coupling is now gone — a newly
Keycloak-admin'd practitioner does **not** automatically start
receiving edit notifications; that still needs its own, separate
`alert_subscriptions` row (unchanged mechanism, just no longer wired to
this endpoint). More honest (the two concerns were never really the
same thing), but a real difference from before, stated here rather than
discovered by surprise.

**What's still NOT real RBAC/identity, said plainly rather than implied
fixed:** this is a role-SOURCE swap only — Medplum and Keycloak are
**not federated**. Practitioners/patients still log into Medplum
directly, completely unchanged; Keycloak is only where this service
looks up an already-Medplum-identified caller's admin role, not an
identity provider Medplum delegates login to. There's no SSO between
the two systems, and provisioning a practitioner into Keycloak is still
a separate manual/seed step from their Medplum account existing —
reconciling that is a bigger, separate open item (blueprint §16). Token
validation for WHO is calling (as opposed to WHAT role they have) still
calls Medplum's `/auth/me` live on every request rather than verifying
the JWT locally against Medplum's JWKS — unchanged by this update,
correct today but a network round trip per request where local
verification would be faster; a legitimate follow-up, not hidden.
`POST /notifications/:id/read` and `POST /notifications/read-all` ARE
now gated by caller identity too (see the self-or-admin bullet above) —
that gap, tracked here in earlier revisions of this README, is closed.

## API

```
POST /events
  { resourceType, resourceId, patientId, action: 'create'|'update',
    actorId, actorName, summary, originalAuthorId?, originalAuthorName? }
  -> { eventId, notifiedCount }

GET /notifications?recipientId=X&unreadOnly=false
  Requires Authorization: Bearer <Medplum access token>. Non-admin
  callers may only pass their OWN practitioner id as recipientId (401 no
  token, 403 someone else's id without a Keycloak admin role).
POST /notifications/:id/read
POST /notifications/read-all   { recipientId }
  Both require Authorization: Bearer <Medplum access token>. Same
  self-or-admin rule as GET /notifications: you may mark your own
  notifications read, or anyone's if you hold an active tenant_admin/
  compliance_officer alert_subscriptions role. (401 no/invalid token,
  403 someone else's without an admin role, 404 on :id/read if the
  notification id doesn't exist.)

POST /subscriptions   { practitionerId, practitionerName, role }
  -> { practitionerId, practitionerName, role }   (201)
  Grants `role` to `practitionerId` in Keycloak (hins-dev realm),
  creating the Keycloak user on first use if needed. 502 if the
  Keycloak write itself fails (caller was already verified as admin).
GET  /subscriptions
  -> every practitioner currently holding tenant_admin or
  compliance_officer, queried live from Keycloak.
  Both require Authorization: Bearer <token> for a caller who
  themselves holds a Keycloak realm role of tenant_admin or
  compliance_officer (401 no/invalid token, 403 valid token/no role).
```

## Try it

```bash
node scripts/seed/seed-keycloak-roles.mjs   # one-time (idempotent) Keycloak role-source setup
npm run dev -w services/audit-service       # :4005
```

**Env vars for the Keycloak role lookup** (dev defaults match what
`scripts/seed/seed-keycloak-roles.mjs` seeds against this repo's own
docker-compose Keycloak — a real deployment sets these from a secret
store):

| Var | Default |
|---|---|
| `KEYCLOAK_BASE_URL` | `http://localhost:8080` |
| `KEYCLOAK_REALM` | `hins-dev` |
| `KEYCLOAK_SERVICE_CLIENT_ID` | `hins-rbac-service` |
| `KEYCLOAK_SERVICE_CLIENT_SECRET` | (seed script's generated secret — see `src/keycloakRoles.ts`) |

Edit a note or prescription as one practitioner in `apps/web`, then sign
in as a subscribed role (`admin@example.com` / `medplum_admin`) and check
the bell — or query directly:

```bash
curl "localhost:4005/notifications?recipientId=<practitioner id>" \
  -H "Authorization: Bearer <that practitioner's own Medplum access token>"
```

Getting a real token for a test: same password + PKCE device-flow login
`apps/web` uses against `:8103` (`admin@example.com` / `medplum_admin`,
or any seeded practitioner login from `scripts/seed/`).
