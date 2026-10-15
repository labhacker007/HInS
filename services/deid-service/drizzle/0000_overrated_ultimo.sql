CREATE TYPE "public"."deid_method" AS ENUM('safe_harbor', 'limited_dataset', 'pseudonymized');--> statement-breakpoint
CREATE TYPE "public"."disclosure_action" AS ENUM('export', 'reidentify');--> statement-breakpoint
CREATE TABLE "disclosure_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"action" "disclosure_action" NOT NULL,
	"method" "deid_method",
	"purpose" text,
	"requester_id" text NOT NULL,
	"requester_display_name" text NOT NULL,
	"patient_ids" text[] NOT NULL,
	"resource_types_included" text[],
	"record_count" integer,
	"justification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pseudonym_mapping" (
	"pseudonym_id" uuid PRIMARY KEY NOT NULL,
	"real_patient_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
