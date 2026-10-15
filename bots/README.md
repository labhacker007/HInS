# bots — Medplum Bots (AI layer, consent gating)

Not scaffolded yet — this is Phase 04 (AI-first layer) in
[docs/PLATFORM_BLUEPRINT.md](../../docs/PLATFORM_BLUEPRINT.md#13--phased-roadmap).

Per §08.2, this is where the voice-to-text ambient scribe pipeline and
consent-gating hooks attach to the Medplum core, as serverless TypeScript
functions triggered on FHIR resource events — not as forks of Medplum itself.
Two Bots are specified there and will be the first two written:

- A Bot on `Encounter` → `in-progress` that checks for a logged recording
  consent event before allowing capture to start (§04.5, §08.1 step 1).
- A Bot on a completed recording that runs the ASR → redaction → structuring
  chain (§08.1 steps 2–4) and writes a draft note for clinician review.

Needs a running Medplum project (`npm run infra:up`) with a Bot enabled
before any of this can be written against a real project ID.
