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
 * Not yet backed by a real terminology server. Next step: stand up a FHIR
 * terminology server (e.g. an Ontoserver- or HAPI-FHIR-backed $lookup/
 * $validate-code endpoint) behind this API, loaded with the licensed
 * SNOMED CT India edition, LOINC, and the confirmed ICD edition (§03.5 flags
 * ICD-10 vs. ICD-11 as still unconfirmed against the 2016 MoHFW standard).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4002);

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'terminology-service', status: 'ok' }));
    return;
  }

  if (req.url?.startsWith('/lookup')) {
    res.writeHead(501, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'not_implemented',
        message: 'No terminology server wired up yet — see docs/PLATFORM_BLUEPRINT.md §03.5/§03.6',
      })
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, () => {
  console.log(`terminology-service listening on :${PORT}`);
});
