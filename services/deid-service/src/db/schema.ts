/**
 * Drizzle schema for the De-identification Service's own tables, on the
 * same postgres-hins instance as consent-service (infra/docker-compose.yml
 * — separate from Medplum's own postgres:16), with its own table names so
 * there's no collision.
 *
 * Two tables, deliberately kept apart:
 *
 *   disclosureAuditLog — who got what, when, under which method/purpose.
 *   This table itself holds real patient IDs, on purpose: HIPAA's
 *   "accounting of disclosures" (45 CFR 164.528) and GDPR's Article 30
 *   records of processing both require tracking WHO a disclosure was made
 *   to and WHAT was disclosed, even when the disclosed data itself is
 *   de-identified. That makes this table more sensitive than the exports
 *   it describes — a real deployment needs to restrict read access to it
 *   to the compliance_officer role (blueprint §10.1), not leave it open
 *   the way this dev build's GET /audit does.
 *
 *   pseudonymMapping — ONLY ever written for the `pseudonymized` method
 *   (GDPR Art. 4(5)/Recital 26). `safe_harbor` and `limited_dataset`
 *   pseudonyms are random and never stored anywhere — that's what makes
 *   them irreversible. A row existing here is what makes a pseudonym
 *   "pseudonymized" rather than "anonymized": re-identification stays
 *   possible for an authorized caller (POST /reidentify), which is the
 *   whole point of that tier (admin/ops use where re-contacting the
 *   patient may be needed) — but it means this table is itself personal
 *   data under GDPR and needs the same access restriction as the audit
 *   log above.
 */
import { pgTable, pgEnum, text, timestamp, uuid, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const deidMethodEnum = pgEnum('deid_method', ['safe_harbor', 'limited_dataset', 'pseudonymized']);
export const disclosureActionEnum = pgEnum('disclosure_action', ['export', 'reidentify']);

export const disclosureAuditLog = pgTable('disclosure_audit_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  action: disclosureActionEnum('action').notNull(),
  method: deidMethodEnum('method'),
  purpose: text('purpose'),
  requesterId: text('requester_id').notNull(),
  requesterDisplayName: text('requester_display_name').notNull(),
  // Real patient IDs — see file header on why this table holds them.
  patientIds: text('patient_ids').array().notNull(),
  resourceTypesIncluded: text('resource_types_included').array(),
  recordCount: integer('record_count'),
  justification: text('justification'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pseudonymMapping = pgTable('pseudonym_mapping', {
  pseudonymId: uuid('pseudonym_id').primaryKey(),
  realPatientId: text('real_patient_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
