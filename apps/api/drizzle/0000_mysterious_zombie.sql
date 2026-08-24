CREATE TYPE "public"."activity" AS ENUM('sedentary', 'light', 'moderate', 'active', 'very_active');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('exact', 'confirmed', 'rough');--> statement-breakpoint
CREATE TYPE "public"."cooking_fat" AS ENUM('none', 'oil', 'ghee', 'butter');--> statement-breakpoint
CREATE TYPE "public"."cooks" AS ENUM('self', 'family', 'mess', 'tiffin', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."diet" AS ENUM('veg', 'nonveg', 'egg', 'vegan', 'jain');--> statement-breakpoint
CREATE TYPE "public"."fact_kind" AS ENUM('sleep', 'workout', 'mood', 'symptom', 'energy', 'weight', 'travel', 'cycle', 'medication', 'other');--> statement-breakpoint
CREATE TYPE "public"."goal" AS ENUM('lose', 'gain', 'maintain', 'recomp');--> statement-breakpoint
CREATE TYPE "public"."meal_type" AS ENUM('breakfast', 'lunch', 'dinner', 'snack');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "chat_role" NOT NULL,
	"content" text NOT NULL,
	"proactive" boolean DEFAULT false NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit" text NOT NULL,
	"grams_per_unit" real NOT NULL,
	"kcal_per_100g" real NOT NULL,
	"protein_per_100g" real NOT NULL,
	"carb_per_100g" real NOT NULL,
	"fat_per_100g" real NOT NULL,
	"fat_varies" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"default_cooking_fat" "cooking_fat" DEFAULT 'oil' NOT NULL,
	"default_fat_tsp" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"usd" numeric(12, 8) NOT NULL,
	"failovers" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "known_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"attribute_key" text NOT NULL,
	"value" text NOT NULL,
	"settled_by" text NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "life_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_message_id" uuid,
	"kind" "fact_kind" NOT NULL,
	"value" numeric(10, 2),
	"unit" text,
	"verbatim" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meal_id" uuid NOT NULL,
	"user_food_id" uuid,
	"global_food_id" uuid,
	"name" text NOT NULL,
	"portion_label" text NOT NULL,
	"units" real NOT NULL,
	"grams" real NOT NULL,
	"kcal" real NOT NULL,
	"protein_g" real NOT NULL,
	"carb_g" real NOT NULL,
	"fat_g" real NOT NULL,
	"cooking_fat" "cooking_fat",
	"cooking_fat_tsp" real,
	"model_confidence" real NOT NULL,
	"confidence" "confidence" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meal_type" "meal_type",
	"eaten_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kcal" real NOT NULL,
	"protein_g" real NOT NULL,
	"carb_g" real NOT NULL,
	"fat_g" real NOT NULL,
	"confidence" "confidence" NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"failovers" integer DEFAULT 0 NOT NULL,
	"questions_asked" integer DEFAULT 0 NOT NULL,
	"questions_skipped_known" integer DEFAULT 0 NOT NULL,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safety_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"level" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"surface" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"root_hashes" jsonb NOT NULL,
	"tx_hashes" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"bytes" integer NOT NULL,
	"fragmented" boolean DEFAULT false NOT NULL,
	"anchor_index" integer,
	"anchor_tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_foods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalised_name" text NOT NULL,
	"based_on_global_food_id" uuid,
	"unit" text NOT NULL,
	"grams_per_unit" real NOT NULL,
	"kcal_per_100g" real NOT NULL,
	"protein_per_100g" real NOT NULL,
	"carb_per_100g" real NOT NULL,
	"fat_per_100g" real NOT NULL,
	"cooking_fat" "cooking_fat",
	"cooking_fat_tsp" real,
	"usual_units" real,
	"times_logged" integer DEFAULT 0 NOT NULL,
	"last_logged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"phone" text,
	"email" text,
	"display_name" text,
	"sex" "sex",
	"age_years" integer,
	"height_cm" real,
	"activity" "activity" DEFAULT 'light',
	"goal" "goal" DEFAULT 'maintain',
	"pace_kg_per_week" real,
	"diet" "diet" DEFAULT 'veg',
	"cooks" "cooks" DEFAULT 'self',
	"meal_times" jsonb,
	"tone" text DEFAULT 'straight' NOT NULL,
	"record_pub_key" text,
	"anchor_address" text,
	"blocked_reason" text,
	"proactive_opt_out" boolean DEFAULT false NOT NULL,
	"last_proactive_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "weight_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"weight_kg" real NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_usage" ADD CONSTRAINT "inference_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "known_attributes" ADD CONSTRAINT "known_attributes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "life_facts" ADD CONSTRAINT "life_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "life_facts" ADD CONSTRAINT "life_facts_source_message_id_chat_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_user_food_id_user_foods_id_fk" FOREIGN KEY ("user_food_id") REFERENCES "public"."user_foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_global_food_id_global_foods_id_fk" FOREIGN KEY ("global_food_id") REFERENCES "public"."global_foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meals" ADD CONSTRAINT "meals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_foods" ADD CONSTRAINT "user_foods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_foods" ADD CONSTRAINT "user_foods_based_on_global_food_id_global_foods_id_fk" FOREIGN KEY ("based_on_global_food_id") REFERENCES "public"."global_foods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_logs" ADD CONSTRAINT "weight_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_user_time_idx" ON "chat_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "global_foods_name_idx" ON "global_foods" USING btree ("name");--> statement-breakpoint
CREATE INDEX "usage_user_time_idx" ON "inference_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "known_attr_unique_idx" ON "known_attributes" USING btree ("user_id","attribute_key");--> statement-breakpoint
CREATE INDEX "life_facts_user_kind_idx" ON "life_facts" USING btree ("user_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "life_facts_unresolved_idx" ON "life_facts" USING btree ("user_id","resolved_at");--> statement-breakpoint
CREATE INDEX "meal_items_meal_idx" ON "meal_items" USING btree ("meal_id");--> statement-breakpoint
CREATE INDEX "meals_user_time_idx" ON "meals" USING btree ("user_id","eaten_at");--> statement-breakpoint
CREATE INDEX "safety_user_time_idx" ON "safety_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "snapshots_user_time_idx" ON "snapshots" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_foods_unique_idx" ON "user_foods" USING btree ("user_id","normalised_name");--> statement-breakpoint
CREATE INDEX "users_household_idx" ON "users" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "weight_user_time_idx" ON "weight_logs" USING btree ("user_id","recorded_at");