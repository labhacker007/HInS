CREATE TYPE "public"."consent_purpose" AS ENUM('self_use', 'treatment', 'payment', 'research');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('granted', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('data_sharing', 'treatment_authorization', 'research', 'recording', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."propagation_status" AS ENUM('pending', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "consent_records" (
	"consent_id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" "consent_type" NOT NULL,
	"grantor_patient_id" text NOT NULL,
	"grantor_representative_person_id" text,
	"grantor_representative_relationship" text,
	"scope" text[] NOT NULL,
	"purpose_code" "consent_purpose" NOT NULL,
	"requester_id" text NOT NULL,
	"requester_display_name" text NOT NULL,
	"requester_external_ref" text,
	"validity_start" timestamp with time zone NOT NULL,
	"validity_expiry" timestamp with time zone NOT NULL,
	"status" "consent_status" DEFAULT 'granted' NOT NULL,
	"signature" text,
	"revokes" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revocation_propagation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"consent_id" uuid NOT NULL,
	"recipient_id" text NOT NULL,
	"status" "propagation_status" DEFAULT 'pending' NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "revocation_propagation" ADD CONSTRAINT "revocation_propagation_consent_id_consent_records_consent_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consent_records"("consent_id") ON DELETE no action ON UPDATE no action;