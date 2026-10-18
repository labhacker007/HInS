/**
 * Drizzle schema for the Audit & Alerting Service — the "Audit & Logging"
 * cross-cutting service named in docs/PLATFORM_BLUEPRINT.md §06's
 * architecture diagram, implemented here for clinical-resource edits
 * specifically (not yet every PHI read/write §09 eventually calls for —
 * see this service's README).
 */
import { pgTable, pgEnum, text, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const editActionEnum = pgEnum('edit_action', ['create', 'update']);

/** Every recorded clinical-resource edit — what changed, who did it, when. */
export const editEvents = pgTable('edit_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  patientId: text('patient_id').notNull(),
  action: editActionEnum('action').notNull(),
  actorId: text('actor_id').notNull(),
  actorName: text('actor_name').notNull(),
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Static, seeded subscription list: which practitioners get alerted on
 * every edit, by role. A placeholder for real role-derived alerting
 * (blueprint §10) — there's no Practitioner-to-role assignment mechanism
 * yet, so this table IS the role assignment for alerting purposes today.
 * Seeded by scripts/seed/seed-demo-data.mjs.
 */
export const alertSubscriptions = pgTable('alert_subscriptions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  practitionerId: text('practitioner_id').notNull(),
  practitionerName: text('practitioner_name').notNull(),
  role: text('role').notNull(), // e.g. 'tenant_admin', 'compliance_officer' — @hins/shared's Role values, kept as plain text here to avoid a cross-service enum-sync dependency
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One in-app alert for one recipient about one edit event. */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  eventId: uuid('event_id')
    .notNull()
    .references(() => editEvents.id),
  recipientId: text('recipient_id').notNull(),
  recipientName: text('recipient_name').notNull(),
  reason: text('reason').notNull(), // 'role_subscription' | 'original_author'
  read: boolean('read').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
