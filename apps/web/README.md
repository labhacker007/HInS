# apps/web — clinician & admin web app

Not scaffolded yet — this is Phase 01 (Core clinical MVP) in
[docs/PLATFORM_BLUEPRINT.md](../../docs/PLATFORM_BLUEPRINT.md#13--phased-roadmap),
which depends on Phase 00's Medplum instance actually being up and a project
created in it first (`npm run infra:up`, then register at
http://localhost:3000).

When this phase starts: a Vite + React app built on `@medplum/react` (the
UI kit that ships with the confirmed EMR/EHR core, Decisions log entry
2026-10-15), pointed at the local `medplum-server` from
[infra/docker-compose.yml](../../infra/docker-compose.yml).
