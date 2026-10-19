/**
 * Loads the repo-root `.env` (written by `npm run bootstrap`) into
 * process.env, so seed/verify scripts pick up this machine's Medplum project
 * id, client ids and service secrets without hardcoding them.
 *
 * Variables already set in the environment always win (Node's
 * process.loadEnvFile never overrides), so `MEDPLUM_BASE_URL=... node x.mjs`
 * still points a script at a different stack. HINS_ENV_FILE overrides the
 * path. Import this module FIRST: ESM evaluates imports before the importing
 * module's body, so constants that read process.env see the loaded values.
 */
import { existsSync } from 'node:fs';
import { ENV_FILE } from './paths.mjs';

export { REPO_ROOT, ENV_FILE } from './paths.mjs';

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
