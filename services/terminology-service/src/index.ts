/**
 * Terminology Service — Phase 00 scaffold.
 *
 * Single internal source for SNOMED CT / LOINC / ICD-10-or-11 lookups
 * (docs/PLATFORM_BLUEPRINT.md §03.6, §06), so clinical modules call this
 * service instead of embedding a terminology or its license directly.
 *
 * Licensing note this service exists to enforce: SNOMED CT use in India is
 * free but still requires an NRCeS/C-DAC Pune affiliate license (§03.5) —
 * that license is held once, here, not re-negotiated per module.
 *
 * Decisions log, 2026-10-15: planned to sit in front of a HAPI FHIR
 * (Apache-2.0) terminology server rather than hand-rolling SNOMED CT graph
 * traversal — HAPI ships $lookup/$validate-code/$expand out of the box.
 * Not wired up yet: that needs the actual licensed SNOMED CT India edition
 * loaded, which isn't available in this environment. This is still a
 * zero-dependency-beyond-Fastify stub.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 4002);

const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.get(
  '/health',
  {
    schema: {
      response: { 200: z.object({ service: z.literal('terminology-service'), status: z.literal('ok') }) },
    },
  },
  async () => ({ service: 'terminology-service' as const, status: 'ok' as const })
);

app.get(
  '/lookup',
  {
    schema: {
      querystring: z.object({ system: z.string(), code: z.string() }),
      response: { 501: z.object({ error: z.string(), message: z.string() }) },
    },
  },
  async (_req, reply) => {
    reply.code(501);
    return {
      error: 'not_implemented',
      message: 'No terminology server wired up yet — see docs/PLATFORM_BLUEPRINT.md §03.5/§03.6',
    };
  }
);

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`terminology-service listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
