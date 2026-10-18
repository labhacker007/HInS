/**
 * Consent Service — Phase 00.
 *
 * Owns every consent event as an immutable, append-only record
 * (docs/PLATFORM_BLUEPRINT.md §04.1). Real persistence against the
 * dedicated postgres-hins instance (infra/docker-compose.yml), via Drizzle.
 *
 * A clinician-initiated request now goes through a real pending-approval
 * state machine before it's active (POST /consents with
 * requiresApproval=true -> status='pending' -> POST .../approve or
 * .../deny), closing the §16 "Consent approval round trip" gap — but only
 * the HIP/HIU side of it, within HInS itself. Still ahead, not here yet:
 *   - A standalone/external PHR-style consent-manager app — §16 left that
 *     as an open design question ("does HInS build a reference consent-
 *     manager app, or only implement the HIP/HIU side") and this task
 *     answered it by building only the HIP/HIU side, in-app.
 *   - ABDM HIE-CM protocol adapter (artefact exchange with a *real*
 *     external Consent Manager, §04.2) and cryptographic signing of
 *     outgoing artefacts.
 *   - A real recipient-notification worker for revocation propagation
 *     (this service only records propagation rows as "pending" today —
 *     nothing actually calls out to a recipient HIP/HIU yet)
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
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
  DecideConsentSchema,
  ErrorResponseSchema,
  ListConsentsQuerySchema,
  RevokeConsentSchema,
} from './schemas.js';

const PORT = Number(process.env.PORT ?? 4001);
const MEDPLUM_BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103';

/**
 * Caller-identity resolution for the consent approve/deny ownership gate
 * below. Same researched approach as services/audit-service/src/index.ts's
 * resolveCaller() (see that file's header for the full "why GET /auth/me
 * and not /oauth2/userinfo or a forwarded-token Practitioner read" writeup
 * — not repeated here) — duplicated in this service's own file rather
 * than factored into a shared package, matching this codebase's existing
 * "each service duplicates its own auth-resolution logic" convention
 * (blueprint §16).
 *
 * Generalized from audit-service's version, which only ever needs to
 * resolve a Practitioner (every audit-service caller is clinical staff):
 * this service's approve/deny callers are PATIENTS, so this one reads
 * `membership.profile.reference` for either a "Practitioner/<id>" or a
 * "Patient/<id>" prefix and returns which kind it resolved, instead of
 * assuming Practitioner like audit-service's does.
 */
type CallerResourceType = 'Practitioner' | 'Patient';

interface AuthedCaller {
  resourceType: CallerResourceType;
  id: string;
  displayName: string;
}

async function resolveCaller(authHeader: string | undefined): Promise<AuthedCaller | undefined> {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  let res: Response;
  try {
    res = await fetch(`${MEDPLUM_BASE_URL}/auth/me`, { headers: { authorization: authHeader } });
  } catch {
    // Medplum unreachable — fail closed (undefined -> 401), never fall
    // back to trusting an unverified caller.
    return undefined;
  }
  if (!res.ok) return undefined;
  const body: any = await res.json().catch(() => undefined);
  const ref: string | undefined = body?.membership?.profile?.reference;
  if (ref?.startsWith('Practitioner/')) {
    return { resourceType: 'Practitioner', id: ref.slice('Practitioner/'.length), displayName: body?.membership?.profile?.display ?? ref };
  }
  if (ref?.startsWith('Patient/')) {
    return { resourceType: 'Patient', id: ref.slice('Patient/'.length), displayName: body?.membership?.profile?.display ?? ref };
  }
  return undefined;
}

/**
 * Ownership gate for POST /consents/:id/approve and .../deny — closes the
 * §16 "neither endpoint checks that the caller is actually the patient the
 * pending request is for" gap. 401s if the bearer token doesn't resolve to
 * a real Medplum caller on this project; 403s if it resolves to anyone
 * other than the one Patient this pending request is actually for
 * (another patient, or ANY practitioner — this is deliberately not an
 * admin/clinician override, because the point of the approval step is
 * that only the patient themselves decides). Returns the caller on
 * success; undefined means a response was already sent and the route
 * handler must return immediately without writing its own body.
 *
 * What this explicitly does NOT model, stated plainly rather than glossed
 * over: a legal representative/guardian approving on the patient's
 * behalf. CreateConsentSchema has an optional `grantor.representative`
 * field (personId + relationship) for exactly that case, but this check
 * only ever accepts the resolved caller being the grantor PATIENT
 * (Patient/<grantorPatientId>) — a representative's own Medplum identity,
 * even one correctly recorded on the original request, is never accepted
 * here. Representative-initiated approval remains an open gap (see this
 * service's README and docs/PLATFORM_BLUEPRINT.md §16).
 */
async function requirePatientOwnerCaller(
  req: FastifyRequest,
  reply: FastifyReply,
  grantorPatientId: string
): Promise<AuthedCaller | undefined> {
  const caller = await resolveCaller(req.headers.authorization);
  if (!caller) {
    reply.code(401);
    reply.send({
      error: 'unauthorized',
      message: 'Provide Authorization: Bearer <token> with a valid Medplum access token for the HInS Dev project.',
    });
    return undefined;
  }
  if (caller.resourceType !== 'Patient' || caller.id !== grantorPatientId) {
    reply.code(403);
    reply.send({
      error: 'forbidden',
      message: `This action may only be taken by the patient this consent request is for (Patient/${grantorPatientId}). Caller resolved to ${caller.resourceType}/${caller.id}.`,
    });
    return undefined;
  }
  return caller;
}

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
    // §04.2/§16: a clinician-initiated request (requiresApproval=true)
    // lands as 'pending' and needs the patient's own POST .../approve
    // before it's ever active; a patient granting their own consent
    // directly (requiresApproval omitted/false) still grants immediately.
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
        status: b.requiresApproval ? 'pending' : 'granted',
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
    // history (active grants, pending requests awaiting approval, revoked/
    // denied grants, and the original grants revoke rows supersede). Used
    // by the "show revoked consents too" views in apps/web (both clinician
    // and patient) — the active-only GET /consents stays as-is for places
    // that only care about current access, and correctly excludes
    // 'pending' rows (status !== 'granted') until they're approved.
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

app.post(
  '/consents/:id/approve',
  {
    schema: {
      params: z.object({ id: z.uuid() }),
      body: DecideConsentSchema,
      response: {
        200: ConsentRecordResponseSchema,
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
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
    if (original.status !== 'pending') {
      reply.code(409);
      return {
        error: 'not_pending',
        message: 'Only a record with status=pending can be approved',
      };
    }

    // Ownership gate — added to close the §16 "neither endpoint checks
    // that the caller is actually the patient the pending request is
    // for" gap. See requirePatientOwnerCaller()'s header for exactly what
    // this does and doesn't model (notably: no representative/guardian
    // support, even though CreateConsentSchema has an optional
    // grantor.representative field).
    const caller = await requirePatientOwnerCaller(req, reply, original.grantorPatientId);
    if (!caller) return;

    // UPDATE in place, not an INSERT — see schema.ts header for why this
    // one transition is a documented exception to the append-only ledger
    // (a pending request was never an effective grant, so there's no
    // history being overwritten). validityStart resets to now: the
    // original request's proposed start is just that — a proposal — the
    // grant only actually becomes effective once the patient approves it.
    const [updated] = await db
      .update(consentRecords)
      .set({ status: 'granted', validityStart: new Date() })
      .where(eq(consentRecords.consentId, original.consentId))
      .returning();

    return updated;
  }
);

app.post(
  '/consents/:id/deny',
  {
    schema: {
      params: z.object({ id: z.uuid() }),
      body: DecideConsentSchema,
      response: {
        200: ConsentRecordResponseSchema,
        401: ErrorResponseSchema,
        403: ErrorResponseSchema,
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
    if (original.status !== 'pending') {
      reply.code(409);
      return {
        error: 'not_pending',
        message: 'Only a record with status=pending can be denied',
      };
    }

    // Ownership gate — see the approve handler above and
    // requirePatientOwnerCaller()'s header for what this does and
    // doesn't model.
    const caller = await requirePatientOwnerCaller(req, reply, original.grantorPatientId);
    if (!caller) return;

    // Denial is a terminal state that reuses 'revoked' rather than adding
    // a fifth enum value — distinguishable from an actual post-grant
    // revoke by statusNote being set and validityStart never having been
    // reset to an approval time (§16 "Consent approval round trip" — this
    // is the documented choice the task called out as needing one).
    const [updated] = await db
      .update(consentRecords)
      .set({ status: 'revoked', statusNote: req.body.note ?? 'Denied by patient (never approved)' })
      .where(eq(consentRecords.consentId, original.consentId))
      .returning();

    return updated;
  }
);

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`consent-service listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
