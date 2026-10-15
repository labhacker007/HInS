# HInS

Modular, API-first, AI-native hospital platform. The plan — compliance
framework, architecture, licensing strategy, AI design, roadmap — lives in
[docs/PLATFORM_BLUEPRINT.md](docs/PLATFORM_BLUEPRINT.md). Read that first;
this file is just how to get a local dev environment running.

## Layout

```
apps/
  web/           Phase 01 MVP — clinician/doctor app + patient portal, one
                 app split by FHIR profile role. See its own README.
bots/            Medplum Bots: AI layer, consent gating (Phase 04, not scaffolded yet)
services/
  consent-service/       Phase 00 — owns every consent event (blueprint §04)
  terminology-service/   Phase 00 — SNOMED CT/LOINC/ICD lookups (blueprint §03.6)
packages/
  shared/        TypeScript types shared across services — consent records,
                 RBAC roles — mirrors blueprint §04.1 and §10.1
infra/
  docker-compose.yml   Local stack: Medplum (confirmed EMR/EHR core) + Keycloak
                        + a separate Postgres 18/pgvector instance for our
                        own services (blueprint §06 — deliberately not
                        shared with Medplum's own postgres:16)
docs/
  PLATFORM_BLUEPRINT.md   The living plan — update this, not just code, when
                           a decision gets made
scripts/
  dev-auth/      GitHub push/pull auth for this repo — see its own README
  seed/          Demo data — patients, a second clinician, coded
                 diagnoses/labs. See its own README.
```

## Prerequisites

- **Docker Desktop**, running. If `docker` isn't found, its CLI may not be
  linked onto `PATH` — on macOS, either open Docker from Spotlight once, or
  call it by full path: `/Applications/Docker.app/Contents/Resources/bin/docker`.
- **Node.js 22** (`.nvmrc` pins this). Install via:
  - [nvm](https://github.com/nvm-sh/nvm) (no sudo, per-project version via `.nvmrc`) — then `nvm install`
  - [Homebrew](https://brew.sh) + `brew install node@22`
  - The official Node.js installer from nodejs.org

## Bring up the stack

```bash
npm run infra:up      # starts both Postgres instances, Redis, Medplum server+app, Keycloak
npm run infra:logs    # tail logs — first boot takes a few minutes
```

Then:

- Medplum app: http://localhost:3000 — the **HInS Dev** project and an
  admin account already exist (Medplum seeds `admin@example.com` /
  `medplum_admin` on first boot of a fresh stack; this was used to create
  the HInS Dev project itself via `Project/$init`). No manual registration
  step needed. See `apps/web/README.md` for the full set of test accounts.
- Medplum API: http://localhost:8103
- Keycloak admin console: http://localhost:8080 (`admin` / `admin` — dev
  credentials only, see `infra/docker-compose.yml`)
- HInS services DB: `postgres://hins:hins@localhost:5433/hins` — Postgres 18
  with pgvector, used by consent-service/terminology-service, separate from
  Medplum's own Postgres on :5432

```bash
npm run infra:down    # stop everything
```

## Install & build the TypeScript workspaces

```bash
npm install
npm run build

# one-time: apply the consent-service schema to the HInS Postgres instance
cd services/consent-service
DATABASE_URL="postgres://hins:hins@localhost:5433/hins" npx drizzle-kit migrate
cd ../..

npm run dev:consent-service       # http://localhost:4001/health
npm run dev:terminology-service   # http://localhost:4002/health
```

Both services run on Fastify + Zod (blueprint §07, Decisions log
2026-10-15). `consent-service` has real persistence against its own
Postgres — `POST /consents`, `GET /consents?patientId=...`, and
`POST /consents/:id/revoke` are implemented and append-only, per blueprint
§04.1. `terminology-service` is still a stub (`/health` and a 501 on
`/lookup`) pending a licensed SNOMED CT terminology server to sit behind it
(§03.5). After changing `services/consent-service/src/db/schema.ts`, run
`npm run db:generate -w services/consent-service` to create a new
migration, then `db:migrate` the same way as above.

## Run the MVP app

```bash
npm run dev -w apps/web    # http://localhost:5173
npm run seed:demo          # one-time — populates patients, a second
                            # clinician, and coded diagnoses/labs
```

One app, role-split by who signs in — see `apps/web/README.md` for what's
built, the test accounts, and the one documented simplification (consent
grants write directly rather than routing through an approval step yet).

## Pushing changes

This repo's push/pull auth uses short-lived GitHub App tokens, not a saved
key — see [scripts/dev-auth/README.md](scripts/dev-auth/README.md). Run
`scripts/dev-auth/setup.sh` once per clone before your first push.
