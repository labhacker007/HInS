#!/usr/bin/env node
/**
 * Seeds audit-service's `alert_subscriptions` table (who gets an in-app
 * notification when someone edits a note or prescription — POST /events
 * fan-out). Writes straight to postgres-hins: audit-service's own
 * POST /subscriptions is now an admin-only Keycloak ROLE write (see its
 * index.ts), a separate concern from notification fan-out.
 *
 * Subscribers, resolved live from the HInS Dev Medplum project:
 *   - the project admin's Practitioner (admin@example.com)  -> tenant_admin
 *   - security@stjones.example's Practitioner (Alex Fernandes) -> compliance_officer
 *
 * Idempotent: a row is inserted only if none exists for that practitioner+role.
 * Prereqs: DB migrations applied, seed-demo-data.mjs run.
 * Env: DATABASE_URL (default postgres://hins:hins@localhost:5433/hins), MEDPLUM_*.
 */
import { adminLogin, profileIdByEmail, whoAmI } from './_medplum-client.mjs';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://hins:hins@localhost:5433/hins';

const token = await adminLogin();
const subs = [{ practitionerId: (await whoAmI(token)).profileId, practitionerName: 'Medplum Admin', role: 'tenant_admin' }];
const fernandes = await profileIdByEmail(token, 'security@stjones.example');
if (fernandes) subs.push({ practitionerId: fernandes, practitionerName: 'Alex Fernandes', role: 'compliance_officer' });
else console.log('  security@stjones.example not found (run seed-demo-data.mjs) — skipped');

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  for (const s of subs) {
    const r = await client.query(
      `INSERT INTO alert_subscriptions (practitioner_id, practitioner_name, role)
       SELECT $1::text, $2::text, $3::text
       WHERE NOT EXISTS (SELECT 1 FROM alert_subscriptions WHERE practitioner_id = $1 AND role = $3)`,
      [s.practitionerId, s.practitionerName, s.role],
    );
    console.log(`  ${r.rowCount ? 'created' : 'exists: '} ${s.practitionerName} (${s.role}) Practitioner/${s.practitionerId}`);
  }
} finally {
  await client.end();
}
console.log('Done.');
