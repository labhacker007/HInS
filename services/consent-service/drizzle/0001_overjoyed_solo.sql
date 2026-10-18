ALTER TYPE "public"."consent_status" ADD VALUE 'pending';--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "status_note" text;