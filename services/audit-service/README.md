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

**`alert_subscriptions` is a placeholder for real role-derived alerting.**
There's no mechanism yet that reads a practitioner's actual RBAC role
(blueprint §10) and alerts them accordingly — this table *is* the role
assignment, seeded by hand. A real deployment needs this driven by the
same role source of truth as access control itself, not a separate list
that can drift from it.

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
  caller must have an active `alert_subscriptions` row with role
  `tenant_admin` or `compliance_officer`. No token → 401; valid token,
  wrong role → 403 naming the roles required.
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

**What's still NOT real RBAC, said plainly rather than implied fixed:**
the role source of truth is still this same hand-seeded
`alert_subscriptions` table — anyone with direct Postgres access, or a
compromised admin session, can still grant an arbitrary practitioner an
admin role by inserting a row; there's no Keycloak-integrated role
system behind it yet (blueprint §16, still open). Token validation calls
Medplum's `/auth/me` live on every request rather than verifying the
JWT locally against Medplum's JWKS — correct today, but a network round
trip per request where local verification would be faster; a legitimate
follow-up, not hidden.

## API

```
POST /events
  { resourceType, resourceId, patientId, action: 'create'|'update',
    actorId, actorName, summary, originalAuthorId?, originalAuthorName? }
  -> { eventId, notifiedCount }

GET /notifications?recipientId=X&unreadOnly=false
  Requires Authorization: Bearer <Medplum access token>. Non-admin
  callers may only pass their OWN practitioner id as recipientId (401 no
  token, 403 someone else's id without an admin role).
POST /notifications/:id/read
POST /notifications/read-all   { recipientId }
  Both require Authorization: Bearer <Medplum access token>. Same
  self-or-admin rule as GET /notifications: you may mark your own
  notifications read, or anyone's if you hold an active tenant_admin/
  compliance_officer alert_subscriptions role. (401 no/invalid token,
  403 someone else's without an admin role, 404 on :id/read if the
  notification id doesn't exist.)

POST /subscriptions   { practitionerId, practitionerName, role }
GET  /subscriptions
  Both require Authorization: Bearer <token> for a caller with an active
  alert_subscriptions role of tenant_admin or compliance_officer.
```

## Try it

```bash
npm run dev -w services/audit-service   # :4005
```

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
