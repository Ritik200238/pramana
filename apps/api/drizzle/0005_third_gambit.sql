ALTER TABLE "users" ADD COLUMN "coach_token_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "coach_learned_count" integer DEFAULT 0 NOT NULL;