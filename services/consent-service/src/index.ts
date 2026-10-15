/**
 * Consent Service — Phase 00 scaffold.
 *
 * Owns every consent event as an immutable, append-only record
 * (docs/PLATFORM_BLUEPRINT.md §04.1). This is a skeleton: the endpoints
 * below define the intended surface but aren't backed by real storage yet.
 * Deliberately zero runtime dependencies so far — just Node's built-in
 * http module — so this runs the moment Node is installed, no npm install
 * required for the stub itself.
 *
 * Real implementation needs, roughly in order:
 *   1. A datastore for ConsentRecord (append-only — never UPDATE, only INSERT)
 *   2. POST /consents — grant, validates purpose/scope/validity, signs the artefact
 *   3. POST /consents/:id/revoke — writes a revoke record, fans out
 *      RevocationPropagationStatus jobs per recipient (§04.3)
 *   4. GET /consents?patientId=... — active grants, for the patient portal
 *   5. ABDM HIE-CM protocol adapter (artefact exchange, §04.2)
 */
import { createServer } from 'node:http';
import type { ConsentRecord } from '@hins/shared';

const PORT = Number(process.env.PORT ?? 4001);

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'consent-service', status: 'ok' }));
    return;
  }

  if (req.url === '/consents') {
    // Stub: real handler validates the body against ConsentRecord, persists
    // it, and — for type "data_sharing" — kicks off the ABDM artefact flow.
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'not_implemented',
        message: 'Consent persistence lands with Phase 00 storage — see docs/PLATFORM_BLUEPRINT.md §04.1',
      })
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  console.log(`consent-service listening on :${PORT}`);
});

// Re-exported so other modules in this service can build on the same shape
// while storage is still unimplemented.
export type { ConsentRecord };
