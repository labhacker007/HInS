#!/usr/bin/env node
/**
 * One-shot, idempotent setup of a HInS dev stack: `npm run bootstrap`.
 *
 * Safe to re-run against an existing stack — every step looks for what it
 * would create first and reuses it (it never creates a second "HInS Dev"
 * project, web client or patient login, and never re-runs the one
 * non-idempotent seed, seed-demo-data.mjs, once its data exists).
 *
 *   1. Waits for Medplum and logs in as the super-admin Medplum seeds on first
 *      boot (admin@example.com / medplum_admin).
 *   2. Ensures the "HInS Dev" project (Project/$init), its public PKCE web
 *      ClientApplication "HInS Web (local dev)", and the patient test login
 *      (asha.verma.patient@example.com / PatientTest123!) — then proves the
 *      client + patient login work with a real PKCE sign-in.
 *   3. Writes the ids/secrets to the repo-root .env (compose + scripts) and
 *      apps/web/.env.local (Vite), merging into existing files.
 *   4. Applies every service's Drizzle migrations to postgres-hins (one
 *      shared drizzle.__drizzle_migrations table, applied in timestamp order
 *      across services — see runMigrations()), then runs the seeds in order.
 *   5. Prints URLs and demo logins.
 *
 * Needs: infra up (Medplum, Keycloak, postgres-hins) and consent-service
 * reachable (seed-demo-data writes consents through it). `npm run up` does
 * all of that plus this script.
 *
 * Every endpoint is env-overridable (defaults = infra/docker-compose.yml):
 *   MEDPLUM_BASE_URL, KEYCLOAK_BASE_URL, DATABASE_URL, CONSENT_SERVICE_URL,
 *   AUDIT_SERVICE_URL, DEID_SERVICE_URL, MEDPLUM_APP_URL, HINS_WEB_URL,
 *   VITE_ASR_URL, ADMIN_EMAIL, ADMIN_PASSWORD
 * Output files: HINS_ENV_FILE (default ./.env), HINS_WEB_ENV_FILE
 *   (default apps/web/.env.local).
 * Flags: --skip-seeds (setup + env files + migrations only),
 *        --migrate-only (just the DB migrations; `npm run db:migrate`)
 */
import { REPO_ROOT, ENV_FILE } from './lib/load-env.mjs';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const env = (k, d) => process.env[k] || d;
const MEDPLUM = env('MEDPLUM_BASE_URL', 'http://localhost:8103').replace(/\/$/, '');
const KEYCLOAK = env('KEYCLOAK_BASE_URL', 'http://localhost:8080').replace(/\/$/, '');
const DATABASE_URL = env('DATABASE_URL', 'postgres://hins:hins@localhost:5433/hins');
const CONSENT = env('CONSENT_SERVICE_URL', 'http://localhost:4001');
const AUDIT = env('AUDIT_SERVICE_URL', 'http://localhost:4005');
const DEID = env('DEID_SERVICE_URL', 'http://localhost:4003');
const MEDPLUM_APP = env('MEDPLUM_APP_URL', 'http://localhost:3000');
const WEB = env('HINS_WEB_URL', 'http://localhost:3080');
const ASR = env('VITE_ASR_URL', 'http://localhost:8000');
const ADMIN_EMAIL = env('ADMIN_EMAIL', 'admin@example.com');
const ADMIN_PASSWORD = env('ADMIN_PASSWORD', 'medplum_admin');
const KC_ADMIN_USER = env('KEYCLOAK_BOOTSTRAP_ADMIN_USER', 'admin');
const KC_ADMIN_PASSWORD = env('KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD', 'admin');
const WEB_ENV_FILE = env('HINS_WEB_ENV_FILE', resolve(REPO_ROOT, 'apps/web/.env.local'));
const SKIP_SEEDS = process.argv.includes('--skip-seeds');
const MIGRATE_ONLY = process.argv.includes('--migrate-only');

const PROJECT_NAME = 'HInS Dev';
const WEB_CLIENT_NAME = 'HInS Web (local dev)';
const SERVICE_CLIENT_NAME = `${PROJECT_NAME} Default Client`; // created by Project/$init
const PATIENT = { email: 'asha.verma.patient@example.com', password: 'PatientTest123!', firstName: 'Asha', lastName: 'Verma' };
const KC_REALM = 'hins-dev';
const KC_SERVICE_CLIENT = 'hins-rbac-service';

const log = (msg) => console.log(msg);
const step = (msg) => console.log(`\n=== ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ http
async function http(url, { method = 'GET', body, form, token, raw } = {}) {
  const headers = {};
  let payload;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form);
  } else if (body !== undefined) {
    headers['content-type'] = url.includes('/fhir/') ? 'application/fhir+json' : 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) headers.authorization = `Bearer ${token}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (res.status === 429 && attempt < 10) {
      await sleep(15_000); // Medplum /auth rate limit — wait it out
      continue;
    }
    if (raw) return { status: res.status, ok: res.ok, json };
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
    return json;
  }
}

async function waitFor(label, url, { timeoutSec = 600, ok = (r) => r.ok } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = '';
  for (;;) {
    try {
      const r = await fetch(url);
      if (ok(r)) return log(`  ${label} is up (${url})`);
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = err.cause?.code ?? err.message;
    }
    if (Date.now() > deadline) throw new Error(`${label} not reachable at ${url} after ${timeoutSec}s (${last})`);
    await sleep(3000);
  }
}

// ------------------------------------------------------------------ medplum
const mp = (path, opts) => http(`${MEDPLUM}${path}`, opts);

/** PKCE (S256) login. choose(memberships) picks one when the user has several.
 * Returns { token, membershipProjects } — the latter only when a choice happened. */
async function medplumLogin(email, password, { projectId, clientId, choose } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let r = await mp('/auth/login', {
    method: 'POST',
    body: { email, password, codeChallenge: challenge, codeChallengeMethod: 'S256', scope: 'openid', projectId, clientId },
  });
  const memberships = r.memberships;
  if (memberships) {
    const m = choose?.(memberships);
    if (!m) return { token: undefined, memberships };
    r = await mp('/auth/profile', { method: 'POST', body: { login: r.login, profile: m.id } });
  }
  const t = await mp('/oauth2/token', { method: 'POST', form: { grant_type: 'authorization_code', code: r.code, code_verifier: verifier, ...(clientId ? { client_id: clientId } : {}) } });
  return { token: t.access_token, memberships };
}

const projectIdOf = (m) => m.project?.reference?.split('/')[1];

/** Returns a HInS Dev admin token + project id, creating the project if missing. */
async function ensureProject() {
  const preferred = process.env.MEDPLUM_PROJECT_ID;
  const pickHins = (ms) => {
    const hins = ms.filter((m) => m.project?.display === PROJECT_NAME);
    return hins.find((m) => projectIdOf(m) === preferred) ?? hins[0];
  };
  let { token, memberships } = await medplumLogin(ADMIN_EMAIL, ADMIN_PASSWORD, { choose: pickHins });
  if (token) {
    const me = await mp('/auth/me', { token });
    if (me.project?.name === PROJECT_NAME) {
      const n = (memberships ?? []).filter((m) => m.project?.display === PROJECT_NAME).length;
      log(`  reusing project "${PROJECT_NAME}" Project/${me.project.id}${n > 1 ? ` (WARNING: ${n} projects with this name; picked this one)` : ''}`);
      return { token, projectId: me.project.id, adminPractitionerId: me.profile.id };
    }
    // Single membership that isn't HInS Dev: this token IS the super-admin one.
  } else {
    ({ token } = await medplumLogin(ADMIN_EMAIL, ADMIN_PASSWORD, {
      choose: (ms) => ms.find((m) => m.project?.display === 'Super Admin') ?? ms[0],
    }));
  }
  const created = await mp('/fhir/R4/Project/$init', {
    method: 'POST',
    token,
    body: { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: PROJECT_NAME }] },
  });
  const project = created.resourceType === 'Project' ? created : created.parameter?.find((p) => p.name === 'return')?.resource;
  if (!project?.id) throw new Error(`Project/$init returned no project: ${JSON.stringify(created)}`);
  log(`  created project "${PROJECT_NAME}" Project/${project.id} (owner ${ADMIN_EMAIL})`);
  ({ token } = await medplumLogin(ADMIN_EMAIL, ADMIN_PASSWORD, { projectId: project.id, choose: pickHins }));
  const me = await mp('/auth/me', { token });
  return { token, projectId: project.id, adminPractitionerId: me.profile.id };
}

async function findClientByName(token, name) {
  const b = await mp(`/fhir/R4/ClientApplication?name=${encodeURIComponent(name)}&_count=100`, { token });
  return (b.entry ?? []).map((e) => e.resource).filter((c) => c.name === name);
}

async function ensureWebClient(token) {
  const wanted = process.env.VITE_MEDPLUM_CLIENT_ID;
  const existing = await findClientByName(token, WEB_CLIENT_NAME);
  const client = existing.find((c) => c.id === wanted) ?? existing[0];
  if (client) {
    log(`  reusing ClientApplication "${WEB_CLIENT_NAME}" ${client.id}`);
    return client.id;
  }
  // Public client: no secret is used; the browser signs in with PKCE.
  const c = await mp('/fhir/R4/ClientApplication', {
    method: 'POST',
    token,
    body: { resourceType: 'ClientApplication', name: WEB_CLIENT_NAME, description: 'HInS web app (Vite dev server and dockerised nginx build), PKCE public client', redirectUri: 'http://localhost:5173' },
  });
  log(`  created ClientApplication "${WEB_CLIENT_NAME}" ${c.id}`);
  return c.id;
}

/** deid-service's client_credentials identity: the project's default client. */
async function ensureServiceClient(token, projectId) {
  let [client] = await findClientByName(token, SERVICE_CLIENT_NAME);
  if (client) log(`  reusing ClientApplication "${SERVICE_CLIENT_NAME}" ${client.id}`);
  else {
    client = await mp(`/admin/projects/${projectId}/client`, { method: 'POST', token, body: { name: SERVICE_CLIENT_NAME } });
    log(`  created ClientApplication "${SERVICE_CLIENT_NAME}" ${client.id}`);
  }
  if (!client.secret) client = await mp(`/fhir/R4/ClientApplication/${client.id}`, { token });
  return { id: client.id, secret: client.secret };
}

async function membershipByEmail(token, email) {
  const b = await mp('/fhir/R4/ProjectMembership?_count=1000', { token });
  return (b.entry ?? []).map((e) => e.resource).find((m) => m.user?.display?.toLowerCase() === email);
}

async function ensurePatientLogin(token, projectId) {
  let m = await membershipByEmail(token, PATIENT.email);
  if (m) log(`  reusing patient login ${PATIENT.email} -> ${m.profile.reference}`);
  else {
    m = await mp(`/admin/projects/${projectId}/invite`, {
      method: 'POST',
      token,
      body: { resourceType: 'Patient', firstName: PATIENT.firstName, lastName: PATIENT.lastName, email: PATIENT.email, password: PATIENT.password, sendEmail: false },
    });
    log(`  created patient login ${PATIENT.email} -> ${m.profile.reference}`);
  }
  return m.profile.reference.split('/')[1];
}

// ------------------------------------------------------------------ keycloak
async function keycloakServiceSecret() {
  const t = await http(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    form: { grant_type: 'password', client_id: 'admin-cli', username: KC_ADMIN_USER, password: KC_ADMIN_PASSWORD },
  });
  const r = await http(`${KEYCLOAK}/admin/realms/${KC_REALM}/clients?clientId=${KC_SERVICE_CLIENT}`, { token: t.access_token, raw: true });
  const id = r.ok ? r.json?.[0]?.id : undefined;
  if (!id) return undefined;
  return (await http(`${KEYCLOAK}/admin/realms/${KC_REALM}/clients/${id}/client-secret`, { token: t.access_token })).value;
}

// ------------------------------------------------------------------ env files
/** Sets KEY=value lines in an env file, keeping every other line as-is. */
function mergeEnvFile(path, values, header) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [`# ${header}`, ''];
  if (lines.at(-1) === '') lines.pop();
  const changed = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) {
      if (lines[i] !== `${k}=${v}`) changed.push(k);
      lines[i] = `${k}=${v}`;
    } else {
      lines.push(`${k}=${v}`);
      changed.push(k);
    }
  }
  if (changed.length) writeFileSync(path, `${lines.join('\n')}\n`);
  log(`  ${path.replace(`${REPO_ROOT}/`, '')}: ${changed.length ? `set ${changed.join(', ')}` : 'unchanged'}`);
}

function readEnvValue(path, key) {
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1) || undefined;
}

// ------------------------------------------------------------------ migrations
/**
 * All services' Drizzle migrations share ONE bookkeeping table
 * (drizzle.__drizzle_migrations, drizzle-kit's default), and drizzle's
 * migrator only applies migrations NEWER than the latest row in it. Running
 * `drizzle-kit migrate` per service on an empty DB would therefore skip any
 * service whose migrations are older than one already applied. So this
 * applies all services' migrations in timestamp order, skipping any whose
 * timestamp/hash is already recorded — the exact rows drizzle itself writes,
 * so `npm run db:migrate -w services/<x>` keeps working afterwards.
 */
async function runMigrations() {
  const pg = (await import('pg')).default;
  const all = [];
  for (const svc of readdirSync(resolve(REPO_ROOT, 'services'))) {
    const dir = resolve(REPO_ROOT, 'services', svc, 'drizzle');
    const journal = resolve(dir, 'meta/_journal.json');
    if (!existsSync(journal)) continue;
    for (const e of JSON.parse(readFileSync(journal, 'utf8')).entries) {
      const sql = readFileSync(resolve(dir, `${e.tag}.sql`), 'utf8');
      all.push({ svc, tag: e.tag, when: e.when, sql, hash: createHash('sha256').update(sql).digest('hex') });
    }
  }
  all.sort((a, b) => a.when - b.when);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`postgres-hins not reachable at ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}: ${err.message}`);
      await sleep(2000);
    }
  }
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query('CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    const done = (await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations')).rows;
    const applied = (m) => done.some((r) => r.hash === m.hash || Number(r.created_at) === m.when);
    for (const m of all) {
      if (applied(m)) {
        log(`  already applied: ${m.svc}/${m.tag}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        for (const stmt of m.sql.split('--> statement-breakpoint')) if (stmt.trim()) await client.query(stmt);
        await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [m.hash, m.when]);
        await client.query('COMMIT');
        log(`  applied: ${m.svc}/${m.tag}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.svc}/${m.tag} failed: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------------ seeds
function run(label, cmd, args, childEnv) {
  step(label);
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, env: childEnv, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status ?? r.signal})`);
}

// ------------------------------------------------------------------ main
async function main() {
  if (!existsSync(resolve(REPO_ROOT, 'node_modules/pg'))) {
    step('Installing npm dependencies (node_modules missing)');
    const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm ci failed');
  }

  if (MIGRATE_ONLY) {
    step(`Database migrations (${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')})`);
    return runMigrations();
  }

  step(`Medplum (${MEDPLUM})`);
  await waitFor('Medplum', `${MEDPLUM}/healthcheck`);
  const { token, projectId, adminPractitionerId } = await ensureProject();
  const webClientId = await ensureWebClient(token);
  const serviceClient = await ensureServiceClient(token, projectId);
  const patientId = await ensurePatientLogin(token, projectId);

  // Prove the public client + patient login actually work end to end.
  const p = await medplumLogin(PATIENT.email, PATIENT.password, { clientId: webClientId });
  const pme = await mp('/auth/me', { token: p.token });
  if (pme.profile?.id !== patientId) throw new Error(`patient login resolved to ${pme.profile?.resourceType}/${pme.profile?.id}, expected Patient/${patientId}`);
  log(`  verified: PKCE sign-in via client ${webClientId} as ${PATIENT.email} -> Patient/${patientId}`);

  step(`Keycloak (${KEYCLOAK})`);
  await waitFor('Keycloak', `${KEYCLOAK}/realms/master`);

  const writeEnv = (kcSecret) => {
    step('Env files');
    mergeEnvFile(ENV_FILE, {
      MEDPLUM_BASE_URL: MEDPLUM,
      MEDPLUM_PROJECT_ID: projectId,
      MEDPLUM_SERVICE_CLIENT_ID: serviceClient.id,
      MEDPLUM_SERVICE_CLIENT_SECRET: serviceClient.secret,
      HINS_DEMO_PATIENT_ID: patientId,
      KEYCLOAK_BASE_URL: KEYCLOAK,
      KEYCLOAK_SERVICE_CLIENT_ID: KC_SERVICE_CLIENT,
      KEYCLOAK_SERVICE_CLIENT_SECRET: kcSecret,
      DATABASE_URL,
      CONSENT_SERVICE_URL: CONSENT,
      AUDIT_SERVICE_URL: AUDIT,
      DEID_SERVICE_URL: DEID,
      // Build args for the dockerised web app (infra/docker-compose.app.yml).
      VITE_MEDPLUM_BASE_URL: `${MEDPLUM}/`,
      VITE_MEDPLUM_CLIENT_ID: webClientId,
      VITE_CONSENT_SERVICE_URL: CONSENT,
      VITE_AUDIT_SERVICE_URL: AUDIT,
      VITE_ASR_URL: ASR,
    }, 'Written by `npm run bootstrap` (scripts/bootstrap.mjs) — local dev values for THIS stack. Gitignored; do not commit.');
    const webEnv = {
      VITE_MEDPLUM_BASE_URL: `${MEDPLUM}/`,
      VITE_MEDPLUM_CLIENT_ID: webClientId,
      VITE_CONSENT_SERVICE_URL: CONSENT,
      VITE_AUDIT_SERVICE_URL: AUDIT,
    };
    // ASR settings are user-tunable: only fill them in when absent.
    if (!readEnvValue(WEB_ENV_FILE, 'VITE_ASR_URL')) webEnv.VITE_ASR_URL = ASR;
    if (!readEnvValue(WEB_ENV_FILE, 'VITE_ASR_MODEL')) webEnv.VITE_ASR_MODEL = 'Systran/faster-whisper-small.en';
    mergeEnvFile(WEB_ENV_FILE, webEnv, 'Written by `npm run bootstrap` — see .env.example.');
  };
  writeEnv((await keycloakServiceSecret()) ?? readEnvValue(ENV_FILE, 'KEYCLOAK_SERVICE_CLIENT_SECRET'));

  step(`Database migrations (${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')})`);
  await runMigrations();

  const childEnv = {
    ...process.env,
    MEDPLUM_BASE_URL: MEDPLUM,
    MEDPLUM_PROJECT_ID: projectId,
    HINS_DEMO_PATIENT_ID: patientId,
    KEYCLOAK_BASE_URL: KEYCLOAK,
    DATABASE_URL,
    CONSENT_SERVICE_URL: CONSENT,
    AUDIT_SERVICE_URL: AUDIT,
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
  };

  if (!SKIP_SEEDS) {
    const sharma = await membershipByEmail(token, 'dr.sharma@stjones.example');
    if (sharma) {
      step('seed-demo-data: skipped (dr.sharma@stjones.example already exists — this seed is not idempotent)');
    } else {
      step(`Waiting for consent-service (${CONSENT}) — seed-demo-data records consents through it`);
      await waitFor('consent-service', `${CONSENT}/health`, { timeoutSec: 180 }).catch((err) => {
        throw new Error(`${err.message}\n  Start the app services first: npm run app:up (or npm run dev:consent-service), then re-run npm run bootstrap.`);
      });
      run('seed-demo-data', 'node', ['scripts/seed/seed-demo-data.mjs'], childEnv);
    }
    run('seed-departments', 'node', ['scripts/seed/seed-departments.mjs'], childEnv);
    run('seed-keycloak-roles', 'node', ['scripts/seed/seed-keycloak-roles.mjs'], childEnv);
    run('seed-access-policies', 'node', ['scripts/seed/seed-access-policies.mjs'], childEnv);
    run('seed-staff', 'node', ['scripts/seed/seed-staff.mjs'], childEnv);
    run('seed-beds', 'node', ['scripts/seed/seed-beds.mjs'], childEnv);
    run('seed-payers', 'node', ['scripts/seed/seed-payers.mjs'], childEnv);
    run('seed-alert-subscriptions', 'node', ['scripts/seed/seed-alert-subscriptions.mjs'], childEnv);
    run('seed:showcase', 'npm', ['run', 'seed:showcase', '--silent'], childEnv);
    // seed-keycloak-roles may have just created the service client.
    writeEnv(await keycloakServiceSecret());
  }

  step('Done');
  log(`
  HInS web (docker)      ${WEB}
  HInS web (vite dev)    http://localhost:5173   (npm run dev -w apps/web)
  Medplum API / admin UI ${MEDPLUM}  /  ${MEDPLUM_APP}
  Keycloak admin         ${KEYCLOAK}   (admin / admin)
  Services               consent ${CONSENT}  deid ${DEID}  audit ${AUDIT}
  HInS Dev project       ${projectId}
  Web client id          ${webClientId}

  Demo logins (local dev only):
    Clinician (super-admin)   ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}   Practitioner/${adminPractitionerId}
    Dr. Priya Sharma          dr.sharma@stjones.example / DrSharma123!
    Compliance officer        security@stjones.example / SecurityTest123!
    Patient (Asha Verma)      ${PATIENT.email} / ${PATIENT.password}
    Hospital admin            hospital.admin@stjones.example / Staff123!
    Staff (each role)         lab.tech@, pathologist@, radiologist@, pharmacist@, billing@,
                              triage.nurse@, dietitian@stjones.example / Staff123!

  If the app containers were started before this run, recreate them so they
  pick up .env (client id + service secrets): npm run app:up`);
}

main().catch((err) => {
  console.error(`\nbootstrap failed: ${err.message}`);
  process.exit(1);
});
