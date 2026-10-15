# HInS

Modular, API-first, AI-native hospital platform. The plan — compliance
framework, architecture, licensing strategy, AI design, roadmap — lives in
[docs/PLATFORM_BLUEPRINT.md](docs/PLATFORM_BLUEPRINT.md). Read that first;
this file is just how to get a local dev environment running.

## Layout

```
apps/            Web apps (clinician/admin console — Phase 01, not scaffolded yet)
bots/            Medplum Bots: AI layer, consent gating (Phase 04, not scaffolded yet)
services/
  consent-service/       Phase 00 — owns every consent event (blueprint §04)
  terminology-service/   Phase 00 — SNOMED CT/LOINC/ICD lookups (blueprint §03.6)
packages/
  shared/        TypeScript types shared across services — consent records,
                 RBAC roles — mirrors blueprint §04.1 and §10.1
infra/
  docker-compose.yml   Local stack: Medplum (confirmed EMR/EHR core) + Keycloak
docs/
  PLATFORM_BLUEPRINT.md   The living plan — update this, not just code, when
                           a decision gets made
scripts/
  dev-auth/      GitHub push/pull auth for this repo — see its own README
```

## Prerequisites

- **Docker Desktop** — already installed on this machine but not linked onto
  `PATH`. Either open it from Spotlight once (so it's running), or always
  call the CLI by its full path: `/Applications/Docker.app/Contents/Resources/bin/docker`.
- **Node.js 22** (`.nvmrc` pins this) — **not installed yet** on this
  machine, and there's no Homebrew either. Install one of:
  - [nvm](https://github.com/nvm-sh/nvm) (no sudo, per-project version via `.nvmrc`) — then `nvm install`
  - [Homebrew](https://brew.sh) + `brew install node@22` (if you want brew for other tools too)
  - The official Node.js installer from nodejs.org

## Bring up the stack

```bash
npm run infra:up      # starts Postgres, Redis, Medplum server+app, Keycloak
npm run infra:logs    # tail logs — first boot takes a few minutes
```

Then:

- Medplum app: http://localhost:3000 — first run prompts you to register an
  account and create a project (this becomes your dev FHIR project).
- Medplum API: http://localhost:8103
- Keycloak admin console: http://localhost:8080 (`admin` / `admin` — dev
  credentials only, see `infra/docker-compose.yml`)

```bash
npm run infra:down    # stop everything
```

## Install & build the TypeScript workspaces

```bash
npm install
npm run build
npm run dev:consent-service       # http://localhost:4001/health
npm run dev:terminology-service   # http://localhost:4002/health
```

Both services are Phase 00 scaffolds right now — a working health check and
a typed, 501-stubbed API surface, not real persistence yet. See each
service's `src/index.ts` for what's next.

## Pushing changes

This repo's push/pull auth uses short-lived GitHub App tokens, not a saved
key — see [scripts/dev-auth/README.md](scripts/dev-auth/README.md). Run
`scripts/dev-auth/setup.sh` once per clone before your first push.
