#!/usr/bin/env node
/**
 * `npm run up` — fresh clone to running, seeded stack in one command:
 *
 *   1. npm ci (only if node_modules is missing)
 *   2. infra (Medplum, Keycloak, both Postgres, Redis) and ASR containers
 *   3. consent-service container (seed-demo-data records consents through it)
 *   4. npm run bootstrap — HInS Dev project, web client, patient login,
 *      .env files, DB migrations, all seeds (idempotent)
 *   5. all app containers, built with the .env bootstrap just wrote
 *      (a no-op re-run when nothing changed)
 *
 * Safe to re-run. Honors HINS_STACK / HINS_*_OVERRIDE (scripts/compose.mjs)
 * and every bootstrap env override (scripts/bootstrap.mjs). HINS_SKIP_ASR=1
 * skips the speech-to-text container.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './lib/paths.mjs';
import { compose } from './compose.mjs';

function must(label, status) {
  if (status !== 0) {
    console.error(`\nnpm run up: ${label} failed (exit ${status})`);
    process.exit(status || 1);
  }
}
const run = (cmd, args) => spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' }).status ?? 1;

if (!existsSync(resolve(REPO_ROOT, 'node_modules'))) must('npm ci', run('npm', ['ci', '--no-audit', '--no-fund']));
must('infra up', compose('infra', ['up', '-d']));
if (!process.env.HINS_STACK && process.env.HINS_SKIP_ASR !== '1') must('asr up', compose('asr', ['up', '-d']));
must('consent-service up', compose('app', ['up', '-d', '--build', 'consent-service']));
must('bootstrap', run('node', ['scripts/bootstrap.mjs']));
must('app up', compose('app', ['up', '-d', '--build']));
console.log('\nnpm run up: all containers running. URLs and demo logins are printed above (bootstrap "Done").');
if (!process.env.HINS_STACK && process.env.HINS_SKIP_ASR !== '1') {
  console.log('First time only, for dictation: curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-small.en');
}
