/**
 * Drizzle schema for the Consent Service's own Postgres instance
 * (postgres-hins in infra/docker-compose.yml — pg18, separate from
 * Medplum's own postgres:16).
 *
 * Mirrors ConsentRecord / RevocationPropagationStatus in
 * @hins/shared/consent.ts — keep both in sync. This table is append-only
 * (docs/PLATFORM_BLUEPRINT.md §04.1): application code only ever INSERTs
 * here, never UPDATEs a consent row in place. A revoke is a new row whose
 * `revokes` column points at the grant it supersedes.
 *
 * consentId defaults to Postgres 18's built-in uuidv7() — time-ordered, so
 * rows in this audit-relevant table sort by creation order without a
 * separate timestamp index.
 */
import { pgTable, pgEnum, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const consentTypeEnum = pgEnum('consent_type', [
  'data_sharing',
  'treatment_authorization',
  'research',
  'recording',
  'marketing',
]);

export const consentStatusEnum = pgEnum('consent_status', ['granted', 'revoked', 'expired']);

export const consentPurposeEnum = pgEnum('consent_purpose', [
  'self_use',
  'treatment',
  'payment',
  'research',
]);

export const consentRecords = pgTable('consent_records', {
  consentId: uuid('consent_id')
    .primaryKey()
    .default(sql`uuidv7()`),
  type: consentTypeEnum('type').notNull(),

  grantorPatientId: text('grantor_patient_id').notNull(),
  grantorRepresentativePersonId: text('grantor_representative_person_id'),
  grantorRepresentativeRelationship: text('grantor_representative_relationship'),

  // FHIR health information types in scope — e.g. ["OPDRecord", "LabReport"].
  // Never a wildcard/"all" value; enforced at the application layer (§04.1).
  scope: text('scope').array().notNull(),

  purposeCode: consentPurposeEnum('purpose_code').notNull(),

  requesterId: text('requester_id').notNull(),
  requesterDisplayName: text('requester_display_name').notNull(),
  requesterExternalRef: text('requester_external_ref'),

  validityStart: timestamp('validity_start', { withTimezone: true }).notNull(),
  validityExpiry: timestamp('validity_expiry', { withTimezone: true }).notNull(),

  status: consentStatusEnum('status').notNull().default('granted'),
  signature: text('signature'),

  // Set only on a revoke row; points back at the consentId it supersedes.
  revokes: uuid('revokes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const propagationStatusEnum = pgEnum('propagation_status', ['pending', 'confirmed', 'failed']);

/**
 * Per-recipient revocation propagation tracking — docs §04.3, risk register
 * §15 ("consent revocation not propagated to every HIP in time"). One row
 * per (consentId, recipientId) a revoke needs to fan out to.
 */
export const revocationPropagation = pgTable('revocation_propagation', {
  id: uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`),
  consentId: uuid('consent_id')
    .notNull()
    .references(() => consentRecords.consentId),
  recipientId: text('recipient_id').notNull(),
  status: propagationStatusEnum('status').notNull().default('pending'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});
