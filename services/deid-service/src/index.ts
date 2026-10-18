/**
 * De-identification / Data Exposure Service — docs/PLATFORM_BLUEPRINT.md
 * §11. Sits between any research/admin consumer and the live clinical
 * data: nothing reaches a caller of this service without going through
 * deidentify.ts first.
 *
 * Endpoints:
 *   POST /export       — the main endpoint. De-identifies a cohort of
 *                         patients (+ their Condition/Observation/
 *                         MedicationRequest) under one of three methods.
 *   POST /reidentify    — reverses a `pseudonymized`-method pseudonym.
 *                         Always logged, always requires a justification.
 *   GET  /audit         — lists disclosure audit log entries. In this dev
 *                         build this is unauthenticated; a real
 *                         deployment restricts it to the
 *                         compliance_officer role (blueprint §10.1).
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { randomBytes } from 'node:crypto';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { disclosureAuditLog, pseudonymMapping } from './db/schema.js';
import { DeidMethodSchema, ErrorResponseSchema, ExportRequestSchema, ReidentifyRequestSchema } from './schemas.js';
import { deidentifyResource, newContext, type FhirResource } from './deidentify.js';
import { fhirGet } from './medplumClient.js';

const PORT = Number(process.env.PORT ?? 4003);
const CONSENT_SERVICE_URL = process.env.CONSENT_SERVICE_URL ?? 'http://localhost:4001';
const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';

/**
 * Caller authentication + admin-role check for GET /audit. Duplicated
 * near-verbatim in services/audit-service/src/index.ts — see that copy's
 * header comment for the full writeup of how this was researched against
 * the live Medplum instance (why GET /oauth2/userinfo and a forwarded-
 * token "does Practitioner/{claimedId} return 200" check were both ruled
 * out, and why GET /auth/me is the one that actually can't be spoofed).
 * Not factored into a shared package on purpose — these two services
 * don't share one today (blueprint §16), matching how each already
 * duplicates its own medplumClient-style login logic rather than
 * sharing one module.
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

/** `alert_subscriptions` is audit-service's own table, not one deid-
 * service's db/schema.ts owns or migrates — but both services point at
 * the same physical Postgres database (postgres://hins:hins@localhost:5433/hins,
 * see infra docs), and it already models exactly "which practitioner has
 * which role for alerting/admin purposes," so it's queried here directly
 * by raw SQL rather than duplicated as a second, driftable role table.
 * Deliberately NOT added as a Drizzle table object in this service's own
 * schema.ts — that would misleadingly imply deid-service owns/migrates
 * it. */
async function activeRoleFor(practitionerId: string): Promise<string | undefined> {
  const result = await db.execute<{ role: string }>(
    sql`SELECT role FROM alert_subscriptions WHERE practitioner_id = ${practitionerId} AND active = true LIMIT 1`
  );
  return result.rows[0]?.role;
}

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
      message: `This endpoint requires an active alert_subscriptions role of ${ADMIN_ROLES.join(' or ')}. Caller Practitioner/${caller.practitionerId} has ${role ?? 'no'} role.`,
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
  { schema: { response: { 200: z.object({ service: z.literal('deid-service'), status: z.literal('ok') }) } } },
  async () => ({ service: 'deid-service' as const, status: 'ok' as const })
);

/** True only if the patient has an active `research`-purpose consent on
 * file. Only method=safe_harbor + purpose=research is gated this way —
 * limited_dataset and pseudonymized map to HIPAA's "healthcare
 * operations" category, which doesn't require patient authorization, per
 * this service's README. */
async function hasResearchConsent(patientId: string): Promise<boolean> {
  const res = await fetch(`${CONSENT_SERVICE_URL}/consents?patientId=${encodeURIComponent(patientId)}`);
  if (!res.ok) return false;
  const consents: Array<{ purposeCode: string }> = await res.json();
  return consents.some((c) => c.purposeCode === 'research');
}

async function fetchPatientBundle(patientId: string, includeResourceTypes: string[]) {
  const resources: FhirResource[] = [];
  const patient = await fhirGet(`Patient/${patientId}`);
  resources.push(patient);
  for (const rt of includeResourceTypes) {
    const bundle = await fhirGet(`${rt}?subject=Patient/${patientId}&_count=50`);
    for (const entry of bundle.entry ?? []) resources.push(entry.resource);
  }
  return resources;
}

app.post(
  '/export',
  {
    schema: {
      body: ExportRequestSchema,
      response: {
        200: z.object({
          method: DeidMethodSchema,
          exportedAt: z.string(),
          patients: z.array(
            z.object({
              pseudonymId: z.string(),
              resources: z.array(z.record(z.string(), z.unknown())),
            })
          ),
          skipped: z.array(z.object({ patientId: z.string(), reason: z.string() })),
        }),
      },
    },
  },
  async (req) => {
    const { patientIds, method, purpose, requesterId, requesterDisplayName, includeResourceTypes } = req.body;
    const ctx = newContext(method, randomBytes(32).toString('hex'));

    const patients: Array<{ pseudonymId: string; resources: FhirResource[] }> = [];
    const skipped: Array<{ patientId: string; reason: string }> = [];
    const includedRealPatientIds: string[] = [];
    let recordCount = 0;

    for (const patientId of patientIds) {
      if (method === 'safe_harbor' && purpose === 'research') {
        const ok = await hasResearchConsent(patientId);
        if (!ok) {
          skipped.push({ patientId, reason: 'No active research-purpose consent on file (blueprint §04)' });
          continue;
        }
      }

      let raw: FhirResource[];
      try {
        raw = await fetchPatientBundle(patientId, includeResourceTypes);
      } catch (err) {
        skipped.push({ patientId, reason: `Could not fetch records: ${String(err)}` });
        continue;
      }

      const deidentified = raw.map((r) => deidentifyResource(r, ctx)).filter((r): r is FhirResource => r !== undefined);
      const pseudonymId = ctx.patientIdMap.get(patientId)!;
      patients.push({ pseudonymId, resources: deidentified });
      includedRealPatientIds.push(patientId);
      recordCount += deidentified.length;
    }

    if (method === 'pseudonymized') {
      const rows = includedRealPatientIds.map((realId) => ({
        pseudonymId: ctx.patientIdMap.get(realId)!,
        realPatientId: realId,
      }));
      for (const row of rows) {
        await db.insert(pseudonymMapping).values(row).onConflictDoNothing();
      }
    }

    if (includedRealPatientIds.length > 0) {
      await db.insert(disclosureAuditLog).values({
        action: 'export',
        method,
        purpose,
        requesterId,
        requesterDisplayName,
        patientIds: includedRealPatientIds,
        resourceTypesIncluded: ['Patient', ...includeResourceTypes],
        recordCount,
      });
    }

    return { method, exportedAt: new Date().toISOString(), patients, skipped };
  }
);

app.post(
  '/reidentify',
  {
    schema: {
      body: ReidentifyRequestSchema,
      response: {
        200: z.object({ realPatientId: z.string() }),
        404: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    const { pseudonymId, requesterId, requesterDisplayName, justification } = req.body;
    const [row] = await db.select().from(pseudonymMapping).where(eq(pseudonymMapping.pseudonymId, pseudonymId)).limit(1);
    if (!row) {
      reply.code(404);
      // Deliberately the same error for "never existed" and "was
      // safe_harbor/limited_dataset, never stored" — distinguishing them
      // would leak which method produced a given pseudonym.
      return { error: 'not_found', message: 'No reversible mapping for this pseudonym.' };
    }

    await db.insert(disclosureAuditLog).values({
      action: 'reidentify',
      requesterId,
      requesterDisplayName,
      patientIds: [row.realPatientId],
      justification,
    });

    return { realPatientId: row.realPatientId };
  }
);

app.get(
  '/audit',
  {
    schema: {
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
      response: {
        200: z.array(z.record(z.string(), z.unknown())),
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    // Gated: this table holds real patient IDs on every disclosure (see
    // db/schema.ts's header) and is itself sensitive — restricted to
    // compliance_officer/tenant_admin (blueprint §10.1, §16). See
    // requireAdminCaller's header comment for how the caller's identity
    // is actually verified against the live Medplum instance.
    const caller = await requireAdminCaller(req, reply);
    if (!caller) return;
    return db.query.disclosureAuditLog.findMany({
      orderBy: (t, { desc }) => desc(t.createdAt),
      limit: req.query.limit,
    });
  }
);

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`deid-service listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
