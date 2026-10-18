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

**`GET /audit`-equivalent access is unauthenticated in this dev build** —
`GET /subscriptions` and `POST /subscriptions` have no access control.
Same gap as `deid-service`'s `GET /audit`: needs restricting to
`compliance_officer`/`tenant_admin` before this goes near real data.

## API

```
POST /events
  { resourceType, resourceId, patientId, action: 'create'|'update',
    actorId, actorName, summary, originalAuthorId?, originalAuthorName? }
  -> { eventId, notifiedCount }

GET /notifications?recipientId=X&unreadOnly=false
POST /notifications/:id/read
POST /notifications/read-all   { recipientId }

POST /subscriptions   { practitionerId, practitionerName, role }
GET  /subscriptions
```

## Try it

```bash
npm run dev -w services/audit-service   # :4005
```

Edit a note or prescription as one practitioner in `apps/web`, then sign
in as a subscribed role (`admin@example.com` / `medplum_admin`) and check
the bell — or query directly:

```bash
curl "localhost:4005/notifications?recipientId=<practitioner id>"
```
