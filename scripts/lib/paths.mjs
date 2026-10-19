/** Repo paths shared by the scripts (no side effects — see load-env.mjs). */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Repo-root .env written by `npm run bootstrap` (HINS_ENV_FILE overrides). */
export const ENV_FILE = process.env.HINS_ENV_FILE ?? resolve(REPO_ROOT, '.env');
