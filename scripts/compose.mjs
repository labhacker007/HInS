#!/usr/bin/env node
/**
 * Thin `docker compose` wrapper for the three HInS compose files:
 *
 *   node scripts/compose.mjs infra <args...>   infra/docker-compose.yml     (project "infra")
 *   node scripts/compose.mjs asr   <args...>   infra/docker-compose.asr.yml (project "hins-asr")
 *   node scripts/compose.mjs app   <args...>   infra/docker-compose.app.yml (project "hins-app")
 *
 * For `app` it passes the repo-root .env (written by `npm run bootstrap`)
 * as --env-file when it exists, so the web build gets this machine's Medplum
 * client id and the services get their client secrets. (Compose would only
 * auto-read infra/.env, and a missing --env-file is an error, hence this.)
 *
 * Throwaway/parallel stacks: HINS_STACK=<name> runs infra as project <name>
 * and app as <name>-app on network <name>_default; HINS_INFRA_OVERRIDE /
 * HINS_APP_OVERRIDE add an extra -f file (e.g. remapped host ports). ASR is
 * a fixed-name singleton and is refused under HINS_STACK.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, ENV_FILE } from './lib/paths.mjs';

export function dockerBin() {
  const r = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  if (r.status === 0) return 'docker';
  const mac = '/Applications/Docker.app/Contents/Resources/bin/docker';
  if (existsSync(mac)) return mac;
  throw new Error('docker CLI not found — install/start Docker Desktop (see README prerequisites)');
}

export function composeArgs(target) {
  const stack = process.env.HINS_STACK;
  const f = (p) => ['-f', resolve(REPO_ROOT, p)];
  switch (target) {
    case 'infra':
      return [...(stack ? ['-p', stack] : []), ...f('infra/docker-compose.yml'), ...(process.env.HINS_INFRA_OVERRIDE ? ['-f', process.env.HINS_INFRA_OVERRIDE] : [])];
    case 'asr':
      if (stack) throw new Error('ASR (hins-asr-speaches) is a single shared container; not started for HINS_STACK stacks');
      return f('infra/docker-compose.asr.yml');
    case 'app':
      return [
        ...(stack ? ['-p', `${stack}-app`] : []),
        ...(existsSync(ENV_FILE) ? ['--env-file', ENV_FILE] : []),
        ...f('infra/docker-compose.app.yml'),
        ...(process.env.HINS_APP_OVERRIDE ? ['-f', process.env.HINS_APP_OVERRIDE] : []),
      ];
    default:
      throw new Error(`unknown compose target "${target}" (infra | asr | app)`);
  }
}

export function compose(target, args) {
  const env = { ...process.env };
  if (process.env.HINS_STACK && target === 'app') env.HINS_INFRA_NETWORK = `${process.env.HINS_STACK}_default`;
  const full = ['compose', ...composeArgs(target), ...args];
  console.log(`$ docker ${full.join(' ').replaceAll(`${REPO_ROOT}/`, '')}`);
  return spawnSync(dockerBin(), full, { cwd: REPO_ROOT, stdio: 'inherit', env }).status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [target, ...args] = process.argv.slice(2);
  try {
    process.exit(compose(target, args));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
