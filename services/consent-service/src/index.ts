/**
 * Consent Service — Phase 00.
 *
 * Owns every consent event as an immutable, append-only record
 * (docs/PLATFORM_BLUEPRINT.md §04.1). Real persistence against the
 * dedicated postgres-hins instance (infra/docker-compose.yml), via Drizzle.
 *
 * Still ahead, not here yet:
 *   - ABDM HIE-CM protocol adapter (artefact exchange, §04.2)
 *   - Cryptographic signing of outgoing artefacts
 *   - A real recipient-notification worker for revocation propagation
 *     (this service only records propagation rows as "pending" today —
 *     nothing actually calls out to a recipient HIP/HIU yet)
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, gt, isNull, notExists } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db/client.js';
import { consentRecords, revocationPropagation } from './db/schema.js';
import {
  ConsentRecordResponseSchema,
  CreateConsentSchema,
  ErrorResponseSchema,
  ListConsentsQuerySchema,
  RevokeConsentSchema,
} from './schemas.js';

const PORT = Number(process.env.PORT ?? 4001);

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// Dev-only: the web app runs on a different origin (Vite's :5173). A real
// deployment should restrict this to the tenant's actual app origin(s).
await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? true });

app.get(
  '/health',
  {
    schema: {
      response: { 200: z.object({ service: z.literal('consent-service'), status: z.literal('ok') }) },
    },
  },
  async () => ({ service: 'consent-service' as const, status: 'ok' as const })
);

app.post(
  '/consents',
  {
    schema: {
      body: CreateConsentSchema,
      response: { 201: ConsentRecordResponseSchema },
    },
  },
  async (req, reply) => {
    const b = req.body;
    const [row] = await db
      .insert(consentRecords)
      .values({
        type: b.type,
        grantorPatientId: b.grantor.patientId,
        grantorRepresentativePersonId: b.grantor.representative?.personId,
        grantorRepresentativeRelationship: b.grantor.representative?.relationship,
        scope: b.scope,
        purposeCode: b.purposeCode,
        requesterId: b.requester.id,
        requesterDisplayName: b.requester.displayName,
        requesterExternalRef: b.requester.externalRef,
        validityStart: b.validity.start,
        validityExpiry: b.validity.expiry,
        signature: b.signature,
      })
      .returning();
    reply.code(201);
    return row;
  }
);

app.get(
  '/consents',
  {
    schema: {
      querystring: ListConsentsQuerySchema,
      response: { 200: z.array(ConsentRecordResponseSchema) },
    },
  },
  async (req) => {
    // Active grants only: an original grant (revokes IS NULL) that is still
    // "granted", not expired, and has no later revoke row pointing at it.
    // `r` is a distinct alias of the same table so the subquery correlates
    // against the outer row (r.revokes = consentRecords.consentId) instead
    // of comparing a row to itself, which would make NOT EXISTS always true.
    const r = alias(consentRecords, 'r');
    const hasRevoke = db
      .select()
      .from(r)
      .where(eq(r.revokes, consentRecords.consentId));

    return db
      .select()
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.grantorPatientId, req.query.patientId),
          isNull(consentRecords.revokes),
          eq(consentRecords.status, 'granted'),
          gt(consentRecords.validityExpiry, new Date()),
          notExists(hasRevoke)
        )
      )
      .orderBy(desc(consentRecords.createdAt));
  }
);

app.get(
  '/consents/history',
  {
    schema: {
      querystring: ListConsentsQuerySchema,
      response: { 200: z.array(ConsentRecordResponseSchema) },
    },
  },
  async (req) => {
    // Every consent record for this patient, unfiltered — the full
    // append-only history (active grants, revoked grants, and the
    // original grants revoke rows supersede). Used by the "show revoked
    // consents too" views in apps/web (both clinician and patient) — the
    // active-only GET /consents stays as-is for places that only care
    // about current access.
    return db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.grantorPatientId, req.query.patientId))
      .orderBy(desc(consentRecords.createdAt));
  }
);

app.post(
  '/consents/:id/revoke',
  {
    schema: {
      params: z.object({ id: z.uuid() }),
      body: RevokeConsentSchema,
      response: {
        200: ConsentRecordResponseSchema,
        404: ErrorResponseSchema,
        409: ErrorResponseSchema,
      },
    },
  },
  async (req, reply) => {
    const [original] = await db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.consentId, req.params.id))
      .limit(1);

    if (!original) {
      reply.code(404);
      return { error: 'not_found', message: `No consent record with id ${req.params.id}` };
    }
    if (original.status !== 'granted' || original.revokes !== null) {
      reply.code(409);
      return {
        error: 'not_revocable',
        message: 'Only an active original grant (status=granted, not itself a revoke) can be revoked',
      };
    }

    const [revokeRow] = await db
      .insert(consentRecords)
      .values({
        type: original.type,
        grantorPatientId: original.grantorPatientId,
        grantorRepresentativePersonId: original.grantorRepresentativePersonId,
        grantorRepresentativeRelationship: original.grantorRepresentativeRelationship,
        scope: original.scope,
        purposeCode: original.purposeCode,
        requesterId: original.requesterId,
        requesterDisplayName: original.requesterDisplayName,
        requesterExternalRef: original.requesterExternalRef,
        validityStart: original.validityStart,
        validityExpiry: original.validityExpiry,
        status: 'revoked',
        revokes: original.consentId,
      })
      .returning();

    // Seed per-recipient propagation tracking (§04.3) — recording only; no
    // outbound call to any recipient happens yet (see file header).
    if (req.body.recipients.length > 0) {
      await db.insert(revocationPropagation).values(
        req.body.recipients.map((recipientId) => ({
          consentId: original.consentId,
          recipientId,
        }))
      );
    }

    return revokeRow;
  }
);

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`consent-service listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
