/**
 * Audit & Alerting Service — docs/PLATFORM_BLUEPRINT.md §09/§06's "Audit &
 * Logging" cross-cutting service, for clinical-resource edits.
 *
 * POST /events records an edit (who, what, when) and fans out in-app
 * alerts to two kinds of recipient:
 *   1. Role subscribers — everyone in alert_subscriptions (seeded by
 *      scripts/seed/, a placeholder for real role-derived alerting, §10),
 *      minus the person who made the edit.
 *   2. The original author/requester, if the edit was made by someone
 *      else — so the clinician who wrote a note gets told when another
 *      clinician corrects it, even if they're not a subscribed role.
 *
 * "Alerting" here means in-app notifications only (GET /notifications,
 * polled by the clinician app's notification bell) — no email/SMS/pager
 * integration. That's a real gap for actual clinical alerting, not a
 * design choice to treat as finished; see this service's README.
 *
 * `alert_subscriptions` above is used ONLY for the notification-fanout
 * purpose described in (1) — NOT for this service's admin-role
 * authorization checks (GET/POST /subscriptions, the admin branch of
 * GET /notifications) as of 2026-10-18. Those now read a real Keycloak
 * realm instead; see `activeRoleFor()`'s and `keycloakRoles.ts`'s
 * comments below for why these are deliberately two separate concerns
 * now rather than one table serving both.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from './db/client.js';
import { editEvents, alertSubscriptions, notifications } from './db/schema.js';
import { CreateSubscriptionSchema, ErrorResponseSchema, RecordEventSchema } from './schemas.js';
import { activeRoleFromKeycloak, keycloakAssignRole, keycloakListRoleAssignments } from './keycloakRoles.js';

const PORT = Number(process.env.PORT ?? 4005);
const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';

/**
 * Caller authentication + admin-role check for this service's admin-only
 * endpoints (GET/POST /subscriptions, and the recipient check on
 * GET /notifications). Duplicated near-verbatim in
 * services/deid-service/src/index.ts — these two services don't share an
 * npm package today (blueprint §16), and this is ~20 lines, same call as
 * each service already duplicating its own medplumClient-style login
 * logic rather than sharing one.
 *
 * HOW CALLER IDENTITY IS RESOLVED — researched against the actually-
 * running Medplum instance before writing this, not guessed:
 *
 *   - `GET /oauth2/userinfo` (standard OIDC, Medplum supports it) only
 *     returns `{"sub": "<User id>"}` — curl-verified. That's the User
 *     resource id, not the Practitioner/profile id this service's role
 *     lookup (now a Keycloak username, see `keycloakRoles.ts`; formerly
 *     `alert_subscriptions.practitionerId`) is keyed on, so it can't
 *     drive the role check by itself.
 *   - The approach floated when this task was scoped — forward the
 *     caller's own token to `GET /fhir/R4/Practitioner/{claimedId}` and
 *     check it returns 200 for the id the caller claims — was tried
 *     directly against this instance and found INSECURE: this project's
 *     default "Practitioner Access Policy" grants every authenticated
 *     practitioner read access to every *other* Practitioner resource too
 *     (an ordinary staff-directory policy, not patient data). Curl-
 *     verified: Dr. Sharma's own real token successfully GETs
 *     `Practitioner/<Medplum Admin's id>` (200, full record). A "claimed
 *     id" is therefore not provable this way — any caller could claim any
 *     id and the "it returned 200" check would wrongly pass.
 *   - What actually works and is NOT spoofable: Medplum's own
 *     `GET /auth/me`. It takes only the bearer token (no claimed id in
 *     the request at all) and returns `membership.profile.reference`,
 *     resolved server-side from that token's own login session. Curl-
 *     verified: 401 with no/garbage token; 200 with
 *     `Practitioner/65abe91c-...` for admin@example.com's real token and
 *     `Practitioner/62f31908-...` for dr.sharma@stjones.example's real
 *     token — i.e. each token resolves to its OWN owner, with no id
 *     supplied by the caller for Medplum to simply echo back.
 *
 * Trade-off, stated honestly rather than hidden: this makes one live
 * network call to Medplum per authenticated request. Medplum's access
 * tokens are JWTs that could instead be verified locally against its
 * JWKS (faster, no round trip) — that's a legitimate follow-up, not done
 * here; see this service's README.
 */
const ADMIN_ROLES = ['tenant_admin', 'compliance_officer'] as const;

interface AuthedCaller {
  practitionerId: string;
  practitionerName: string;
}

async function resolveCaller(authHeader: string | undefined): Promise<AuthedCaller | undefined> {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  let res: Response;
  try {
    res = await fetch(`${MEDPLUM_BASE_URL}/auth/me`, { headers: { authorization: authHeader } });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const body: any = await res.json().catch(() => undefined);
  const ref: string | undefined = body?.membership?.profile?.reference;
  if (!ref?.startsWith('Practitioner/')) return undefined;
  return { practitionerId: ref.slice('Practitioner/'.length), practitionerName: body?.membership?.profile?.display ?? ref };
}

/**
 * Role source of truth for this service's admin-role check, as of
 * 2026-10-18: a real Keycloak realm (`hins-dev`), not the hand-seeded
 * `alert_subscriptions.role` column this used to query. `alert_subscriptions`
 * itself is NOT retired — `POST /events` below still uses it, unchanged,
 * for a different purpose (who gets notified on an edit). Only its use
 * as an AUTHORIZATION input is replaced here. See
 * services/audit-service/src/keycloakRoles.ts's file header for the
 * full design (service-account client_credentials lookup, fail-closed
 * behavior, caching).
 */
async function activeRoleFor(practitionerId: string): Promise<string | undefined> {
  return activeRoleFromKeycloak(practitionerId, (msg, err) => app.log.error({ err }, msg));
}

/** preHandler-shaped guard for the two admin-only /subscriptions routes.
 * 401s if the bearer token doesn't resolve to a real Medplum caller on
 * this project; 403s if it resolves but isn't tenant_admin/
 * compliance_officer. Returns the caller on success (undefined means a
 * response was already sent — the route handler must return immediately). */
async function requireAdminCaller(req: FastifyRequest, reply: FastifyReply): Promise<AuthedCaller | undefined> {
  const caller = await resolveCaller(req.headers.authorization);
  if (!caller) {
    reply.code(401);
    reply.send({
      error: 'unauthorized',
      message: 'Provide Authorization: Bearer <token> with a valid Medplum access token for the HInS Dev project.',
    });
    return undefined;
  }
  const role = await activeRoleFor(caller.practitionerId);
  if (!role || !(ADMIN_ROLES as readonly string[]).includes(role)) {
    reply.code(403);
    reply.send({
      error: 'forbidden',
      message: `This endpoint requires a Keycloak realm role of ${ADMIN_ROLES.join(' or ')} (realm "${process.env.KEYCLOAK_REALM ?? 'hins-dev'}"). Caller Practitioner/${caller.practitionerId} has ${role ?? 'no'} role.`,
    });
    return undefined;
  }
  return caller;
}

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? true });

app.get(
  '/health',
  { schema: { response: { 200: z.object({ service: z.literal('audit-service'), status: z.literal('ok') }) } } },
  async () => ({ service: 'audit-service' as const, status: 'ok' as const })
);

app.post(
  '/events',
  {
    schema: {
      body: RecordEventSchema,
      response: {
        201: z.object({ eventId: z.uuid(), notifiedCount: z.number() }),
      },
    },
  },
  async (req, reply) => {
    const b = req.body;
    const [event] = await db
      .insert(editEvents)
      .values({
        resourceType: b.resourceType,
        resourceId: b.resourceId,
        patientId: b.patientId,
        action: b.action,
        actorId: b.actorId,
        actorName: b.actorName,
        summary: b.summary,
      })
      .returning();

    const subscribers = await db
      .select()
      .from(alertSubscriptions)
      .where(and(eq(alertSubscriptions.active, true), ne(alertSubscriptions.practitionerId, b.actorId)));

    const recipients = new Map<string, string>(subscribers.map((s) => [s.practitionerId, s.practitionerName]));
    if (b.originalAuthorId && b.originalAuthorId !== b.actorId) {
      recipients.set(b.originalAuthorId, b.originalAuthorName ?? b.originalAuthorId);
    }

    if (recipients.size > 0) {
      await db.insert(notifications).values(
        [...recipients.entries()].map(([recipientId, recipientName]) => ({
          eventId: event.id,
          recipientId,
          recipientName,
          reason: subscribers.some((s) => s.practitionerId === recipientId) ? 'role_subscription' : 'original_author',
        }))
      );
    }

    reply.code(201);
    return { eventId: event.id, notifiedCount: recipients.size };
  }
);

app.get(
  '/notifications',
  {
    schema: {
      querystring: z.object({ recipientId: z.string().min(1), unreadOnly: z.coerce.boolean().default(false) }),
      response: {
        200: z.array(
          z.object({
            id: z.uuid(),
            read: z.boolean(),
            createdAt: z.string(),
            reason: z.string(),
            resourceType: z.string(),
            resourceId: z.string(),
            patientId: z.string(),
            action: z.string(),
            actorName: z.string(),
            summary: z.string(),
          })
        ),
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    // Authenticated callers may always read their OWN notifications (the
    // recipientId they claim must equal their own resolved practitioner
    // id); only tenant_admin/compliance_officer may request someone
    // else's recipientId — see this service's README for why a bare
    // "has a token" check isn't enough here: without this, any caller
    // could read any OTHER practitioner's notifications just by putting
    // a different id in the query string.
    const caller = await resolveCaller(req.headers.authorization);
    if (!caller) {
      reply.code(401);
      return reply.send({
        error: 'unauthorized',
        message: 'Provide Authorization: Bearer <token> with a valid Medplum access token for the HInS Dev project.',
      });
    }
    if (caller.practitionerId !== req.query.recipientId) {
      const role = await activeRoleFor(caller.practitionerId);
      if (!role || !(ADMIN_ROLES as readonly string[]).includes(role)) {
        reply.code(403);
        return reply.send({
          error: 'forbidden',
          message: `You may only read your own notifications (recipientId must equal your own practitioner id, Practitioner/${caller.practitionerId}), or hold a Keycloak realm role of ${ADMIN_ROLES.join(' or ')} to read anyone's.`,
        });
      }
    }

    const rows = await db
      .select({
        id: notifications.id,
        read: notifications.read,
        createdAt: notifications.createdAt,
        reason: notifications.reason,
        resourceType: editEvents.resourceType,
        resourceId: editEvents.resourceId,
        patientId: editEvents.patientId,
        action: editEvents.action,
        actorName: editEvents.actorName,
        summary: editEvents.summary,
      })
      .from(notifications)
      .innerJoin(editEvents, eq(notifications.eventId, editEvents.id))
      .where(
        req.query.unreadOnly
          ? and(eq(notifications.recipientId, req.query.recipientId), eq(notifications.read, false))
          : eq(notifications.recipientId, req.query.recipientId)
      )
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }
);

app.post(
  '/notifications/:id/read',
  {
    schema: {
      params: z.object({ id: z.uuid() }),
      response: {
        200: z.object({ ok: z.literal(true) }),
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    // Same self-or-admin check as GET /notifications, but the recipientId
    // to check against isn't known until the row is read — the :id path
    // param alone doesn't say who owns the notification. So: fetch the
    // row first (single query, just the recipientId we need), 404 if the
    // id doesn't exist at all, THEN apply the self-or-admin check before
    // touching it. This closes the gap this service's README used to
    // call out: "either lets any caller mark any notification id as read
    // without proving ownership."
    const caller = await resolveCaller(req.headers.authorization);
    if (!caller) {
      reply.code(401);
      return reply.send({
        error: 'unauthorized',
        message: 'Provide Authorization: Bearer <token> with a valid Medplum access token for the HInS Dev project.',
      });
    }

    const [row] = await db
      .select({ recipientId: notifications.recipientId })
      .from(notifications)
      .where(eq(notifications.id, req.params.id));
    if (!row) {
      reply.code(404);
      return reply.send({ error: 'not_found', message: `No notification with id ${req.params.id}.` });
    }

    if (caller.practitionerId !== row.recipientId) {
      const role = await activeRoleFor(caller.practitionerId);
      if (!role || !(ADMIN_ROLES as readonly string[]).includes(role)) {
        reply.code(403);
        return reply.send({
          error: 'forbidden',
          message: `You may only mark your own notifications read (this notification belongs to Practitioner/${row.recipientId}, you are Practitioner/${caller.practitionerId}), or hold an active alert_subscriptions role of ${ADMIN_ROLES.join(' or ')} to mark anyone's.`,
        });
      }
    }

    await db.update(notifications).set({ read: true }).where(eq(notifications.id, req.params.id));
    return { ok: true as const };
  }
);

// Admin-role management. As of 2026-10-18, these two endpoints do REAL
// work against the Keycloak `hins-dev` realm — they used to manage rows
// in `alert_subscriptions`, but once `activeRoleFor()` above stopped
// reading that table for authorization, leaving these as plain
// INSERT/SELECT against it would have been actively deceptive: an admin
// calling POST /subscriptions would believe they'd just granted someone
// an admin role, and nothing would actually change. Chosen fix (option
// (a) from this task, not the 410-Gone fallback (b)): repoint both at
// the Keycloak Admin REST API directly (services/audit-service/src/keycloakRoles.ts's
// `keycloakAssignRole`/`keycloakListRoleAssignments`), fully retiring
// `alert_subscriptions.role` as an authorization input. `alert_subscriptions`
// the TABLE still exists and is still used by `POST /events` above for
// its own, separate purpose (who gets an in-app notification on an
// edit) — that is unchanged and intentionally out of scope here.
//
// Behavior change worth stating plainly: before this change, granting
// an admin role via POST /subscriptions ALSO added that practitioner as
// a notification subscriber (same table, same row). That side effect is
// now gone — the two concerns ("is this caller an admin" vs. "who gets
// notified on an edit") are fully decoupled, which is more honest than
// the previous conflation, but it does mean a newly Keycloak-admin'd
// practitioner does NOT automatically start receiving edit notifications
// anymore; that still needs its own `alert_subscriptions` row (unchanged
// mechanism, just no longer wired to this endpoint).
//
// Gated on requireAdminCaller (itself now Keycloak-backed — see its
// header comment). Both routes 502 (not 500/200) if the admin WRITE/LIST
// itself fails after the caller was already verified as admin — a real
// operational error, surfaced honestly rather than swallowed.
app.post(
  '/subscriptions',
  {
    schema: {
      body: CreateSubscriptionSchema,
      response: {
        201: z.object({ practitionerId: z.string(), practitionerName: z.string(), role: z.string() }),
        400: ErrorResponseSchema,
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
        502: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    const caller = await requireAdminCaller(req, reply);
    if (!caller) return;
    // Validated here, before the Keycloak call, so a bad role value is a
    // 400 (client input error) rather than being caught by the generic
    // catch below and misreported as a 502 "Keycloak itself failed" —
    // keycloakAssignRole() throws the same check internally too, but
    // that path is only reached for other (real upstream) failures now.
    if (!(ADMIN_ROLES as readonly string[]).includes(req.body.role)) {
      reply.code(400);
      return { error: 'invalid_role', message: `role must be one of ${ADMIN_ROLES.join(', ')}, got "${req.body.role}".` };
    }
    try {
      await keycloakAssignRole(req.body.practitionerId, req.body.practitionerName, req.body.role);
    } catch (err) {
      app.log.error({ err }, `Keycloak role assignment failed for practitioner ${req.body.practitionerId}`);
      reply.code(502);
      return { error: 'keycloak_error', message: 'Could not assign the role in Keycloak. See service logs.' };
    }
    reply.code(201);
    return { practitionerId: req.body.practitionerId, practitionerName: req.body.practitionerName, role: req.body.role };
  }
);

app.get(
  '/subscriptions',
  {
    schema: {
      response: {
        200: z.array(z.object({ practitionerId: z.string(), practitionerName: z.string(), role: z.string() })),
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
        502: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    const caller = await requireAdminCaller(req, reply);
    if (!caller) return;
    try {
      return await keycloakListRoleAssignments();
    } catch (err) {
      app.log.error({ err }, 'Keycloak role-assignment list failed');
      reply.code(502);
      return { error: 'keycloak_error', message: 'Could not list role assignments from Keycloak. See service logs.' };
    }
  }
);

app.post(
  '/notifications/read-all',
  {
    schema: {
      body: z.object({ recipientId: z.string().min(1) }),
      response: {
        200: z.object({ ok: z.literal(true) }),
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    // Exact same self-or-admin check as GET /notifications, keyed on the
    // body's recipientId instead of a query param — closing the other
    // half of the gap this service's README used to call out.
    const caller = await resolveCaller(req.headers.authorization);
    if (!caller) {
      reply.code(401);
      return reply.send({
        error: 'unauthorized',
        message: 'Provide Authorization: Bearer <token> with a valid Medplum access token for the HInS Dev project.',
      });
    }
    if (caller.practitionerId !== req.body.recipientId) {
      const role = await activeRoleFor(caller.practitionerId);
      if (!role || !(ADMIN_ROLES as readonly string[]).includes(role)) {
        reply.code(403);
        return reply.send({
          error: 'forbidden',
          message: `You may only mark your own notifications read (recipientId must equal your own practitioner id, Practitioner/${caller.practitionerId}), or hold an active alert_subscriptions role of ${ADMIN_ROLES.join(' or ')} to mark anyone's.`,
        });
      }
    }

    await db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.recipientId, req.body.recipientId), eq(notifications.read, false)));
    return { ok: true as const };
  }
);

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`audit-service listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
