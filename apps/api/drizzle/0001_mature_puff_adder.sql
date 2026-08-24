CREATE TYPE "public"."marker_flag" AS ENUM('low', 'normal', 'high', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "health_markers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"report_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"value" numeric(12, 3) NOT NULL,
	"unit" text NOT NULL,
	"ref_low" numeric(12, 3),
	"ref_high" numeric(12, 3),
	"flag" "marker_flag" DEFAULT 'unknown' NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"lab_name" text,
	"collected_at" timestamp with time zone,
	"model" text,
	"summary" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "streaks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current_days" integer DEFAULT 0 NOT NULL,
	"longest_days" integer DEFAULT 0 NOT NULL,
	"last_logged_date" text,
	"freezes_available" integer DEFAULT 1 NOT NULL,
	"freeze_refreshed_on" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "pantry" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "health_markers" ADD CONSTRAINT "health_markers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_markers" ADD CONSTRAINT "health_markers_report_id_lab_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."lab_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "markers_user_code_time_idx" ON "health_markers" USING btree ("user_id","code","measured_at");--> statement-breakpoint
CREATE INDEX "lab_reports_user_time_idx" ON "lab_reports" USING btree ("user_id","created_at");