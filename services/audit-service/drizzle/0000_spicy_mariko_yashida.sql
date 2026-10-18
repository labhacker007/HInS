CREATE TYPE "public"."edit_action" AS ENUM('create', 'update');--> statement-breakpoint
CREATE TABLE "alert_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"practitioner_id" text NOT NULL,
	"practitioner_name" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"action" "edit_action" NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_name" text NOT NULL,
	"reason" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_edit_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."edit_events"("id") ON DELETE no action ON UPDATE no action;