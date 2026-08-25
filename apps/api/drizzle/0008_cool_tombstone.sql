ALTER TABLE "snapshots" ADD COLUMN "owner_signature" text;--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "signature_deadline" bigint;