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
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from './db/client.js';
import { editEvents, alertSubscriptions, notifications } from './db/schema.js';
import { CreateSubscriptionSchema, RecordEventSchema } from './schemas.js';

const PORT = Number(process.env.PORT ?? 4005);

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
      },
    },
  },
  async (req) => {
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
    schema: { params: z.object({ id: z.uuid() }), response: { 200: z.object({ ok: z.literal(true) }) } },
  },
  async (req) => {
    await db.update(notifications).set({ read: true }).where(eq(notifications.id, req.params.id));
    return { ok: true as const };
  }
);

// Admin-only in spirit (role subscriptions decide who gets alerted on
// every edit) — unauthenticated in this dev build, like deid-service's
// GET /audit. Needs the same compliance_officer/tenant_admin-only
// restriction before this goes near real data (§16).
app.post(
  '/subscriptions',
  {
    schema: {
      body: CreateSubscriptionSchema,
      response: { 201: z.object({ id: z.uuid() }) },
    },
  },
  async (req, reply) => {
    const [row] = await db.insert(alertSubscriptions).values(req.body).returning();
    reply.code(201);
    return { id: row.id };
  }
);

app.get(
  '/subscriptions',
  { schema: { response: { 200: z.array(z.record(z.string(), z.unknown())) } } },
  async () => db.select().from(alertSubscriptions).where(eq(alertSubscriptions.active, true))
);

app.post(
  '/notifications/read-all',
  {
    schema: {
      body: z.object({ recipientId: z.string().min(1) }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
  },
  async (req) => {
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
