CREATE TYPE "public"."attestation_status" AS ENUM('verified', 'failed', 'unrequested', 'unavailable');--> statement-breakpoint
ALTER TABLE "inference_usage" ADD COLUMN "attestation" "attestation_status" DEFAULT 'unrequested' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_usage" ADD COLUMN "attestation_provider" text;--> statement-breakpoint
ALTER TABLE "inference_usage" ADD COLUMN "attestation_request_id" text;--> statement-breakpoint
CREATE INDEX "usage_attestation_idx" ON "inference_usage" USING btree ("user_id","attestation");