/**
 * GENERATED — do not edit. Run `bun run generate:hub-migrations`.
 *
 * Interchange's migrations, verbatim, from
 * vendor/interchange/packages/db/migrations at the revision in
 * vendor/interchange/VENDORED_REVISION. They live here as a module so the
 * compiled single-file host carries them; reading them from disk works only
 * from a source checkout.
 */
export type HubMigration = { readonly id: string; readonly sql: string };

export const HUB_MIGRATIONS: readonly HubMigration[] = [
  {
    id: "0000_brown_wither.sql",
    sql: `CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0001_white_aqueduct.sql",
    sql: `CREATE TABLE "federation_trust" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"target_tenant_id" text NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "federation_trust_tenant_id_target_tenant_id_unique" UNIQUE("tenant_id","target_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text NOT NULL,
	"parent_id" text,
	"config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenant_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_tenant_id_kind_ref_id_unique" UNIQUE("tenant_id","kind","ref_id")
);
--> statement-breakpoint
CREATE TABLE "principal_role" (
	"principal_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_role_principal_id_role_id_pk" PRIMARY KEY("principal_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"role_id" text,
	"principal_id" text,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"effect" text NOT NULL,
	"conditions" jsonb,
	"source" text NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system_prompt" text,
	"skills" jsonb,
	"context_config" jsonb,
	"initial_state" jsonb,
	"model_config" jsonb,
	"capabilities" jsonb,
	"current_version" text DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'deployed' NOT NULL,
	"kernel_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_version" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "federation_trust" ADD CONSTRAINT "federation_trust_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_trust" ADD CONSTRAINT "federation_trust_target_tenant_id_tenant_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_parent_id_tenant_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant" ADD CONSTRAINT "grant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant" ADD CONSTRAINT "grant_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant" ADD CONSTRAINT "grant_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version" ADD CONSTRAINT "agent_version_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0002_clever_falcon.sql",
    sql: `CREATE TABLE "credential" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"secret" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"agent_id" text,
	"direction" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"recipient_id" text,
	"sender_id" text,
	"request_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"backend_type" text NOT NULL,
	"currency" text NOT NULL,
	"balance" text DEFAULT '0' NOT NULL,
	"config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pricing" jsonb,
	"schema" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability" ADD CONSTRAINT "capability_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability" ADD CONSTRAINT "capability_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0003_stiff_tyrannus.sql",
    sql: `CREATE TABLE "provider" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"plugin" text NOT NULL,
	"authorization_url" text,
	"token_url" text,
	"user_info_url" text,
	"scopes" text[],
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_tenant_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"redirect_uris" text[],
	"default_scopes" text[],
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_client_tenant_provider" UNIQUE("tenant_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "provider_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "refresh_secret" text;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "scopes" text[];--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_oauth_client_id_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_tenant_name" UNIQUE("tenant_id","name");`,
  },
  {
    id: "0004_rename_capability_to_offering.sql",
    sql: `ALTER TABLE "capability" RENAME TO "offering";
`,
  },
  {
    id: "0005_gigantic_cardiac.sql",
    sql: `ALTER TABLE "agent" ADD COLUMN "credential_requirements" jsonb;`,
  },
  {
    id: "0006_sidecar.sql",
    sql: `CREATE TABLE IF NOT EXISTS "sidecar" (
  "id" text PRIMARY KEY NOT NULL,
  "url" text NOT NULL,
  "status" text DEFAULT 'online' NOT NULL,
  "last_heartbeat" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
`,
  },
  {
    id: "0007_agent_running_session.sql",
    sql: `ALTER TABLE "agent" ADD COLUMN IF NOT EXISTS "session_id" text;
`,
  },
  {
    id: "0008_session.sql",
    sql: `CREATE TABLE IF NOT EXISTS "agent_session" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agent"("id") ON DELETE CASCADE,
  "principal_id" text NOT NULL REFERENCES "principal"("id"),
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "ended_at" timestamp
);
`,
  },
  {
    id: "0009_session_messages.sql",
    sql: `CREATE TABLE IF NOT EXISTS "session_message" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL REFERENCES "agent_session"("id") ON DELETE CASCADE,
  "tenant_id" text NOT NULL REFERENCES "tenant"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "message_part" (
  "id" text PRIMARY KEY NOT NULL,
  "message_id" text NOT NULL REFERENCES "session_message"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL REFERENCES "agent_session"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "content" text,
  "metadata" jsonb,
  "ordinal" integer NOT NULL
);
`,
  },
  {
    id: "0010_agent_sidecar_pubkey.sql",
    sql: `ALTER TABLE "agent" ADD COLUMN "sidecar_id" text REFERENCES "sidecar"("id") ON DELETE SET NULL;
ALTER TABLE "agent" ADD COLUMN "public_key" text;
`,
  },
  {
    id: "0011_session_message_from.sql",
    sql: `ALTER TABLE "session_message" ADD COLUMN "from" text NOT NULL DEFAULT 'unknown';
ALTER TABLE "session_message" ALTER COLUMN "from" DROP DEFAULT;
`,
  },
  {
    id: "0012_agent_instance.sql",
    sql: `CREATE TABLE "agent_instance" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"address" text NOT NULL,
	"version_id" text,
	"status" text DEFAULT 'deployed' NOT NULL,
	"sidecar_id" text,
	"public_key" text,
	"kernel_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	CONSTRAINT "agent_instance_address_unique" UNIQUE("address")
);
--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_version_id_agent_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agent_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_sidecar_id_sidecar_id_fk" FOREIGN KEY ("sidecar_id") REFERENCES "public"."sidecar"("id") ON DELETE set null ON UPDATE no action;
`,
  },
  {
    id: "0013_instance_session_id.sql",
    sql: `ALTER TABLE "agent_instance" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_session_id_agent_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_session"("id") ON DELETE no action ON UPDATE no action;`,
  },
  {
    id: "0014_drop_agent_runtime_columns.sql",
    sql: `-- Normalize any stale runtime statuses before dropping the columns
-- that tracked them. The agent table now only uses deployed/stopped.
UPDATE "agent" SET "status" = 'deployed' WHERE "status" IN ('running', 'updating', 'error');
--> statement-breakpoint
ALTER TABLE "agent" DROP CONSTRAINT IF EXISTS "agent_sidecar_id_sidecar_id_fk";
--> statement-breakpoint
ALTER TABLE "agent" DROP CONSTRAINT IF EXISTS "agent_sidecar_id_fkey";
--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "sidecar_id";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "public_key";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "kernel_id";--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "session_id";
`,
  },
  {
    id: "0015_add_instance_id_to_session_message.sql",
    sql: `ALTER TABLE "session_message" ADD COLUMN "instance_id" text;--> statement-breakpoint
ALTER TABLE "session_message" ADD CONSTRAINT "session_message_instance_id_agent_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."agent_instance"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0016_jazzy_gamma_corps.sql",
    sql: `ALTER TABLE "agent" ADD COLUMN "creator_principal_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "grant_requirements" jsonb;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_creator_principal_id_principal_id_fk" FOREIGN KEY ("creator_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;
`,
  },
  {
    id: "0017_hesitant_marvex.sql",
    sql: `ALTER TABLE "agent" ALTER COLUMN "principal_id" DROP NOT NULL;
`,
  },
  {
    id: "0018_natural_sinister_six.sql",
    sql: `UPDATE "agent" SET "creator_principal_id" = "principal_id" WHERE "creator_principal_id" IS NULL AND "principal_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent" DROP CONSTRAINT "agent_principal_id_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "agent" DROP COLUMN "principal_id";
`,
  },
  {
    id: "0019_rename_grant_source_to_origin.sql",
    sql: `ALTER TABLE "grant" RENAME COLUMN "source" TO "origin";
`,
  },
  {
    id: "0020_add_agent_role.sql",
    sql: `CREATE TABLE "agent_role" (
	"agent_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_role_agent_id_role_id_pk" PRIMARY KEY("agent_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "agent_role" ADD CONSTRAINT "agent_role_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_role" ADD CONSTRAINT "agent_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;
`,
  },
  {
    id: "0021_acoustic_ozymandias.sql",
    sql: `CREATE TABLE "session_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"instance_id" text,
	"tenant_id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_mail" ADD CONSTRAINT "session_mail_session_id_agent_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mail" ADD CONSTRAINT "session_mail_instance_id_agent_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."agent_instance"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mail" ADD CONSTRAINT "session_mail_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_mail_instance_id_created_at_idx" ON "session_mail" USING btree ("instance_id","created_at");`,
  },
  {
    id: "0022_material_sleepwalker.sql",
    sql: `CREATE TABLE "inference_turn" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "turn_part" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"content" text,
	"metadata" jsonb,
	"ordinal" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inference_turn" ADD CONSTRAINT "inference_turn_session_id_agent_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_turn" ADD CONSTRAINT "inference_turn_instance_id_agent_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."agent_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_turn" ADD CONSTRAINT "inference_turn_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_part" ADD CONSTRAINT "turn_part_turn_id_inference_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."inference_turn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_part" ADD CONSTRAINT "turn_part_session_id_agent_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_turn_instance_id_started_at_idx" ON "inference_turn" USING btree ("instance_id","started_at");`,
  },
  {
    id: "0023_flawless_scarlet_witch.sql",
    sql: `DROP TABLE "message_part" CASCADE;--> statement-breakpoint
DROP TABLE "session_message" CASCADE;`,
  },
  {
    id: "0024_bumpy_sharon_ventura.sql",
    sql: `ALTER TABLE "agent" DROP COLUMN "skills";`,
  },
  {
    id: "0025_curvy_firestar.sql",
    sql: `CREATE TABLE "asset" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"creator_principal_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tenant_kind_name" UNIQUE("tenant_id","kind","name")
);
--> statement-breakpoint
CREATE TABLE "agent_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"ref" text NOT NULL,
	"access_mode" text DEFAULT 'read-only' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_asset_agent_asset" UNIQUE("agent_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_creator_principal_id_principal_id_fk" FOREIGN KEY ("creator_principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_asset" ADD CONSTRAINT "agent_asset_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_asset" ADD CONSTRAINT "agent_asset_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0026_keen_ultimo.sql",
    sql: `CREATE TABLE "session_asset" (
	"instance_id" text NOT NULL,
	"agent_asset_id" text NOT NULL,
	"mount_path" text NOT NULL,
	"asset_pack_sha" text NOT NULL,
	"source_commit_sha" text NOT NULL,
	"materialized_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_asset_instance_id_agent_asset_id_pk" PRIMARY KEY("instance_id","agent_asset_id")
);
--> statement-breakpoint
ALTER TABLE "session_asset" ADD CONSTRAINT "session_asset_instance_id_agent_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."agent_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_asset" ADD CONSTRAINT "session_asset_agent_asset_id_agent_asset_id_fk" FOREIGN KEY ("agent_asset_id") REFERENCES "public"."agent_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_asset_pack_sha_idx" ON "session_asset" USING btree ("asset_pack_sha");`,
  },
  {
    id: "0027_git_tokens.sql",
    sql: `CREATE TABLE "git_token" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"user_id" text NOT NULL,
	"principal_id" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash_sha256" "bytea" NOT NULL,
	"resource" text NOT NULL,
	"ref_pattern" text NOT NULL,
	"actions" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_token_token_hash_sha256_unique" UNIQUE("token_hash_sha256")
);
--> statement-breakpoint
ALTER TABLE "git_token" ADD CONSTRAINT "git_token_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_token" ADD CONSTRAINT "git_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_token" ADD CONSTRAINT "git_token_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_token_user_id_name_active_idx" ON "git_token" USING btree ("user_id","name") WHERE "git_token"."revoked_at" is null;`,
  },
  {
    id: "0028_wet_sugar_man.sql",
    sql: `ALTER TABLE "agent" ALTER COLUMN "creator_principal_id" SET NOT NULL;`,
  },
  {
    id: "0029_loose_warlock.sql",
    sql: `ALTER TABLE "agent" ADD COLUMN "tool_packages" jsonb DEFAULT '[]'::jsonb NOT NULL;`,
  },
  {
    id: "0030_session_asset_audit_split.sql",
    sql: `ALTER TABLE "session_asset" DROP CONSTRAINT "session_asset_instance_id_agent_asset_id_pk";--> statement-breakpoint
ALTER TABLE "session_asset" ALTER COLUMN "agent_asset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_asset" ADD CONSTRAINT "session_asset_instance_id_mount_path_pk" PRIMARY KEY("instance_id","mount_path");--> statement-breakpoint
ALTER TABLE "session_asset" ADD COLUMN "source" text NOT NULL DEFAULT 'direct';--> statement-breakpoint
ALTER TABLE "session_asset" ALTER COLUMN "source" DROP DEFAULT;
`,
  },
  {
    id: "0031_gigantic_nicolaos.sql",
    sql: `CREATE TABLE "model" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"canonical_name" text NOT NULL,
	"display_name" text,
	"description" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_tenant_canonical_name" UNIQUE("tenant_id","canonical_name")
);
--> statement-breakpoint
CREATE TABLE "model_offering" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"priority" integer NOT NULL,
	"deployment_tags" text[] DEFAULT '{}' NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_offering_tenant_model_provider" UNIQUE("tenant_id","model_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"offering_id" text NOT NULL,
	"currency" text NOT NULL,
	"input_token_price" text,
	"output_token_price" text,
	"cache_read_token_price" text,
	"cache_write_token_price" text,
	"thinking_token_price" text,
	"per_request_fee" text,
	"per_image_fee" text,
	"per_audio_fee" text,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_pricing_offering_currency_effective_from" UNIQUE("offering_id","currency","effective_from")
);
--> statement-breakpoint
CREATE TABLE "model_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"plugin" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_id" text,
	"wallet_id" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_provider_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "model_provider_auth_xor" CHECK (("model_provider"."credential_id" is not null) <> ("model_provider"."wallet_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_offering" ADD CONSTRAINT "model_offering_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_offering" ADD CONSTRAINT "model_offering_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_offering" ADD CONSTRAINT "model_offering_provider_id_model_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_offering_id_model_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."model_offering"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet"("id") ON DELETE restrict ON UPDATE no action;`,
  },
  {
    id: "0032_lethal_misty_knight.sql",
    sql: `ALTER TABLE "agent" ADD COLUMN "model_requirements" jsonb;`,
  },
  {
    id: "0033_old_payback.sql",
    sql: `ALTER TABLE "agent_instance" ADD COLUMN "model_preferences" jsonb;`,
  },
  {
    id: "0034_sleepy_songbird.sql",
    sql: `CREATE TABLE "workflow_deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"definition_asset_id" text NOT NULL,
	"status" text DEFAULT 'deployed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_deployment" ADD CONSTRAINT "workflow_deployment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_deployment" ADD CONSTRAINT "workflow_deployment_definition_asset_id_asset_id_fk" FOREIGN KEY ("definition_asset_id") REFERENCES "public"."asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_deployment_tenant_idx" ON "workflow_deployment" USING btree ("tenant_id","created_at");`,
  },
  {
    id: "0035_violet_giant_man.sql",
    sql: `ALTER TABLE "workflow_deployment" ADD COLUMN "address" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_deployment" ADD COLUMN "public_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_deployment_address_idx" ON "workflow_deployment" USING btree ("address");`,
  },
  {
    id: "0036_sharp_the_executioner.sql",
    sql: `ALTER TABLE "sidecar" ADD COLUMN "token_hash_sha256" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "sidecar" ADD CONSTRAINT "sidecar_token_hash_sha256_unique" UNIQUE("token_hash_sha256");`,
  },
  {
    id: "0037_credential_use_backfill.sql",
    sql: `-- Backfill \`credential:{id}\` / \`use\` grants for the owner of every existing
-- personal credential (rows where \`principal_id\` is set) that does not already
-- have one. This keeps existing personal-credential owners working once
-- launch enforcement fails closed. Organizational credentials
-- (\`principal_id\` IS NULL) are intentionally excluded: they remain gated
-- behind tenant-owner role inheritance and explicit administrative grants.
--
-- Idempotent: the \`WHERE NOT EXISTS\` guard skips any credential whose owner
-- already holds a matching grant, so re-application inserts nothing and does
-- not fail. Grant ids reproduce the app convention (\`grt_\` prefix followed by
-- 32 hex characters) via \`gen_random_uuid()\`.
INSERT INTO "grant" (
  "id",
  "tenant_id",
  "principal_id",
  "resource",
  "action",
  "effect",
  "origin",
  "expires_at"
)
SELECT
  'grt_' || replace(gen_random_uuid()::text, '-', ''),
  c."tenant_id",
  c."principal_id",
  'credential:' || c."id",
  'use',
  'allow',
  'creator',
  NULL
FROM "credential" c
WHERE c."principal_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "grant" g
    WHERE g."principal_id" = c."principal_id"
      AND g."resource" = 'credential:' || c."id"
      AND g."action" = 'use'
  );
`,
  },
  {
    id: "0038_chilly_blacklash.sql",
    sql: `CREATE TABLE "approval" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"origin_principal_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"tool_definition" jsonb NOT NULL,
	"tool_arguments" jsonb NOT NULL,
	"scope" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"origin_kind" text NOT NULL,
	"timeout_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "approval_correlation_id_unique" UNIQUE("correlation_id")
);
--> statement-breakpoint
CREATE TABLE "signal_correlation" (
	"correlation_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"agent_address" text NOT NULL,
	"run_id" text NOT NULL,
	"signal_name" text NOT NULL,
	"kind" text NOT NULL,
	"signal_id" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_instance_id_agent_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."agent_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_origin_principal_id_principal_id_fk" FOREIGN KEY ("origin_principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_correlation" ADD CONSTRAINT "signal_correlation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0039_quick_carnage.sql",
    sql: `ALTER TABLE "approval" ALTER COLUMN "tool_definition" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ALTER COLUMN "tool_arguments" DROP NOT NULL;`,
  },
  {
    id: "0040_reshape_approval_origin.sql",
    sql: `-- Reshape \`approval\` so its origin is the workflow deployment it came from.
-- The dropped instance/agent/origin-principal FKs had no valid referent: a
-- workflow deployment has no agent_instance/agent row and its run principal is
-- a substrate principal, not a \`principal\`-table row. The three added columns
-- are NOT NULL with no default and no backfill; like the repo's other such
-- adds (e.g. 0014, \`workflow_deployment.address\`), this relies on the table
-- being empty when the migration runs. The table is unreleased -- the approval
-- routes are 501 stubs -- so no populated row predates these columns.
ALTER TABLE "approval" DROP CONSTRAINT "approval_instance_id_agent_instance_id_fk";
--> statement-breakpoint
ALTER TABLE "approval" DROP CONSTRAINT "approval_agent_id_agent_id_fk";
--> statement-breakpoint
ALTER TABLE "approval" DROP CONSTRAINT "approval_origin_principal_id_principal_id_fk";
--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "deployment_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "run_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD COLUMN "agent_address" text NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_deployment_id_workflow_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workflow_deployment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_tenant_status_idx" ON "approval" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "approval_deployment_idx" ON "approval" USING btree ("deployment_id");--> statement-breakpoint
ALTER TABLE "approval" DROP COLUMN "instance_id";--> statement-breakpoint
ALTER TABLE "approval" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "approval" DROP COLUMN "origin_principal_id";--> statement-breakpoint
ALTER TABLE "approval" DROP COLUMN "origin_kind";`,
  },
  {
    id: "0041_make_approval_timeout_at_nullable.sql",
    sql: `ALTER TABLE "approval" ALTER COLUMN "timeout_at" DROP NOT NULL;`,
  },
  {
    id: "0042_youthful_mantis.sql",
    sql: `ALTER TABLE "approval" ALTER COLUMN "tool_definition" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ALTER COLUMN "tool_arguments" SET NOT NULL;`,
  },
  {
    id: "0043_signal_correlation_deployment_fk.sql",
    sql: `ALTER TABLE "signal_correlation" ADD CONSTRAINT "signal_correlation_deployment_id_workflow_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workflow_deployment"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0044_model_offering_quirks.sql",
    sql: `ALTER TABLE "model_offering" ADD COLUMN "quirks" jsonb;`,
  },
  {
    id: "0045_create_workflow_run.sql",
    sql: `CREATE TABLE "workflow_run" (
	"id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"principal_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_deployment_id_workflow_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workflow_deployment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE set null ON UPDATE no action;`,
  },
  {
    id: "0046_approval_signal_correlation_run_fk.sql",
    sql: `ALTER TABLE "approval" ADD CONSTRAINT "approval_run_id_workflow_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_correlation" ADD CONSTRAINT "signal_correlation_run_id_workflow_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0047_create_workflow_definition.sql",
    sql: `CREATE TABLE "workflow_definition" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"creator_principal_id" text,
	"asset_id" text,
	"name" text NOT NULL,
	"description" text,
	"grant_requirements" jsonb,
	"current_version" text DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'deployed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_definition_version" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_definition_version_definition_version" UNIQUE("definition_id","version")
);
--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_creator_principal_id_principal_id_fk" FOREIGN KEY ("creator_principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition_version" ADD CONSTRAINT "workflow_definition_version_definition_id_workflow_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_definition_tenant_idx" ON "workflow_definition" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_asset_idx" ON "workflow_definition" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "workflow_definition_version_definition_idx" ON "workflow_definition_version" USING btree ("definition_id");`,
  },
  {
    id: "0048_workflow_definition_origin_agent_id.sql",
    sql: `ALTER TABLE "workflow_definition" ADD COLUMN "origin_agent_id" text;--> statement-breakpoint
CREATE INDEX "workflow_definition_origin_agent_idx" ON "workflow_definition" USING btree ("origin_agent_id");`,
  },
  {
    id: "0049_curly_omega_flight.sql",
    sql: `DROP INDEX "workflow_definition_origin_agent_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_origin_agent_idx" ON "workflow_definition" USING btree ("origin_agent_id") WHERE "workflow_definition"."origin_agent_id" is not null;`,
  },
  {
    id: "0050_late_crystal.sql",
    sql: `ALTER TABLE "workflow_run" ALTER COLUMN "deployment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "definition_id" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "sidecar_id" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "kernel_id" text;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD COLUMN "model_preferences" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_definition_id_workflow_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_sidecar_id_sidecar_id_fk" FOREIGN KEY ("sidecar_id") REFERENCES "public"."sidecar"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_run_definition_idx" ON "workflow_run" USING btree ("definition_id");`,
  },
  {
    id: "0051_funny_madelyne_pryor.sql",
    sql: `CREATE UNIQUE INDEX "workflow_run_address_idx" ON "workflow_run" USING btree ("address") WHERE "workflow_run"."address" is not null;`,
  },
  {
    id: "0052_drop_inference_turn_instance_fk.sql",
    sql: `ALTER TABLE "inference_turn" DROP CONSTRAINT "inference_turn_instance_id_agent_instance_id_fk";
`,
  },
  {
    id: "0053_session_mail_session_id_index.sql",
    sql: `CREATE INDEX "session_mail_session_id_created_at_idx" ON "session_mail" USING btree ("session_id","created_at");`,
  },
  {
    id: "0054_rekey_instance_grants_to_workflow_run.sql",
    sql: `-- Re-key run-scoped grants onto the folded workflow-run resource. A folded run
-- shares the instance id space, so the rewrite is prefix-identity: the id after
-- the colon is unchanged, only the type name moves instance: -> workflow-run:
-- (carrying instance:* -> workflow-run:* too). The match is colon-delimited so
-- it never touches the unrelated agent-state: grants; there is no instance-state
-- sibling. Idempotent: after this runs no row matches instance:%, so a re-run is
-- a no-op.
UPDATE "grant"
SET resource = 'workflow-run:' || substr(resource, length('instance:') + 1)
WHERE resource LIKE 'instance:%';
`,
  },
  {
    id: "0055_backfill_anchor_workflow_runs.sql",
    sql: `-- Reconstruct an anchor workflow_run for every deployment that predates the
-- runtime anchor insert. A deployment's routing address and reconnect key now
-- live on its anchor run (the workflow_run whose id equals the deployment id),
-- which new deploys create at runtime -- but deployments created earlier have a
-- workflow_deployment row and no anchor run, so the reconnect key lookup finds
-- no run for their address and their reconnect challenge fails closed. This
-- copies the deployment's identity onto a fresh anchor run so those deployments
-- reconnect exactly as ones deployed after the runtime anchor insert do.
--
-- A runtime-created anchor run also carries its definition -- deploy resolves
-- and writes definition_id -- so a reconstructed one must too; an anchor run
-- without a definition is only half the deployment's first-class stand-in. A
-- definition_id resolves from the deployment's asset, which the workflow-asset
-- fold populates. The guard below aborts the migration before it writes
-- anything if any deployment still needing an anchor run has no folded
-- definition, so the backfill reconstructs every anchor run completely or
-- writes nothing and tells the operator to run the fold first. The production
-- path applies migrations under \`drizzle-kit migrate\`, which wraps the pending
-- set in a transaction, and PostgreSQL DDL is transactional, so an aborting
-- guard rolls the whole set back -- there is no partial commit to re-run from
-- the top, so the guard is simply a clear up-front precondition.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "workflow_deployment" wd
    WHERE NOT EXISTS (
        SELECT 1 FROM "workflow_run" r WHERE r.id = wd.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM "workflow_definition" wdef
        WHERE wdef.asset_id = wd.definition_asset_id
      )
  ) THEN
    RAISE EXCEPTION 'workflow-asset fold has not run: a deployment lacks a folded definition and its anchor run would be definition-less. The fold tooling has been retired; create the missing workflow_definition for the deployment asset by hand before applying this migration (see the agent-fold migration note in DEV.md).';
  END IF;
END $$;
--> statement-breakpoint
-- public_key is copied from the deployment (its old deploy-ack key) so the
-- reconnect challenge resolves the same key it did before; created_at is copied
-- so listing order is stable; status is the anchor's live value; definition_id
-- resolves through the folded definition the guard above proved present. The
-- remaining columns match a runtime anchor insert: no principal, no runtime
-- bindings, not ended. NOT EXISTS on the id keeps it idempotent and skips
-- deployments that already have a runtime-created anchor run.
INSERT INTO "workflow_run" (
  id,
  tenant_id,
  deployment_id,
  definition_id,
  address,
  public_key,
  status,
  created_at
)
SELECT
  wd.id,
  wd.tenant_id,
  wd.id,
  wdef.id,
  wd.address,
  wd.public_key,
  'running',
  wd.created_at
FROM "workflow_deployment" wd
LEFT JOIN "workflow_definition" wdef ON wdef.asset_id = wd.definition_asset_id
WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_run" r WHERE r.id = wd.id
);
`,
  },
  {
    id: "0056_repoint_deployment_fks_to_anchor_run.sql",
    sql: `-- Re-point the three deployment_id foreign keys from the workflow_deployment
-- projection onto the anchor run -- the workflow_run whose id equals the
-- deployment id -- leaving the projection unreferenced. Every deployment_id
-- value already equals an anchor run's id (migration 0055 backfilled one per
-- deployment), so each re-pointed constraint validates on add; a deployment
-- that somehow lacks its anchor run makes the ADD CONSTRAINT abort, a free
-- integrity check.
--
-- First, fill definition_id on the runs the projection still anchors, so every
-- run carries its definition -- the run anchors on the definition, not the
-- deployment. A pre-existing non-anchor run -- a folded or child run created
-- before this branch added the column -- has a null definition_id that only the
-- deployment -> asset -> definition join can resolve; migration 0055 fills the
-- anchor runs it inserts but never touches these existing rows, and
-- workflow_deployment is the only place their mapping survives. asset_id is
-- unique per definition, so the join matches at most one definition per run.
UPDATE "workflow_run" r
SET definition_id = wdef.id
FROM "workflow_deployment" wd
JOIN "workflow_definition" wdef ON wdef.asset_id = wd.definition_asset_id
WHERE r.deployment_id = wd.id
  AND r.definition_id IS NULL;
--> statement-breakpoint
ALTER TABLE "approval" DROP CONSTRAINT "approval_deployment_id_workflow_deployment_id_fk";
--> statement-breakpoint
ALTER TABLE "signal_correlation" DROP CONSTRAINT "signal_correlation_deployment_id_workflow_deployment_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_run" DROP CONSTRAINT "workflow_run_deployment_id_workflow_deployment_id_fk";
--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_deployment_id_workflow_run_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_correlation" ADD CONSTRAINT "signal_correlation_deployment_id_workflow_run_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_deployment_id_workflow_run_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;
`,
  },
  {
    id: "0057_drop_workflow_deployment_projection.sql",
    sql: `-- Drop the workflow_deployment projection. Its routing identity, reconnect key,
-- and status now live on the anchor run, its foreign keys were re-pointed onto
-- the anchor run, and nothing reads or writes it. This is irreversible.
--
-- Promote workflow_run.definition_id to NOT NULL: every run now carries a
-- definition (set at birth for new runs, filled by 0056 for the rows the
-- projection anchored). The guard below aborts before writing anything if any
-- run is still null -- that means the workflow-asset fold has not run, and
-- dropping the projection would strand those rows with no way to resolve their
-- definition. A blunt IS NULL check catches every class, including a run with a
-- null deployment_id the deployment join could never reach. Abort loudly so the
-- operator runs the fold and retries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "workflow_run" WHERE definition_id IS NULL) THEN
    RAISE EXCEPTION 'workflow_run rows without a definition remain; run the workflow-asset fold (bin/db-backfill) before applying this migration';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "workflow_run" ALTER COLUMN "definition_id" SET NOT NULL;
--> statement-breakpoint
DROP TABLE "workflow_deployment";
`,
  },
  {
    id: "0058_repoint_offering_fk_to_definition.sql",
    sql: `-- Re-point the offering foreign key off the agent onto the folded workflow
-- definition. The column keeps its agent_id name -- the offering API exposes
-- agentId -- but its values become workflow_definition ids: every agent was
-- folded to exactly one definition, linked by workflow_definition.origin_agent_id
-- (a partial unique index, so the join matches at most one definition).
--
-- The guard runs before any write. The production path applies migrations under
-- \`drizzle-kit migrate\`, which wraps the pending set in a transaction, and
-- PostgreSQL DDL is transactional, so an aborting guard rolls the whole set
-- back -- there is no partial commit to defend against. It aborts loudly if any
-- offering's agent has no folded definition, meaning the agent fold has not
-- run; the total fold makes that impossible in a folded database, so the guard
-- is a fail-loud assertion.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "offering" o
    WHERE NOT EXISTS (
      SELECT 1 FROM "workflow_definition" wd
      WHERE wd.origin_agent_id = o.agent_id
    )
  ) THEN
    RAISE EXCEPTION 'offering(s) reference an agent with no folded definition; run the agent fold (bin/db-backfill) before applying this migration';
  END IF;
END $$;
--> statement-breakpoint
-- Drop the old agent foreign key BEFORE rewriting the values: the rewrite sets
-- agent_id to a workflow_definition id, which is not an agent id, so it would
-- violate the still-active agent FK. The offering table was renamed from
-- \`capability\` (migration 0004); Postgres does not rename constraints on a
-- table rename, so its agent FK still carries the original \`capability_\`-
-- prefixed name, not the \`offering_\`-prefixed name drizzle's snapshot infers.
ALTER TABLE "offering" DROP CONSTRAINT "capability_agent_id_agent_id_fk";
--> statement-breakpoint
UPDATE "offering" o
SET agent_id = wd.id
FROM "workflow_definition" wd
WHERE wd.origin_agent_id = o.agent_id;
--> statement-breakpoint
ALTER TABLE "offering" ADD CONSTRAINT "offering_agent_id_workflow_definition_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workflow_definition"("id") ON DELETE restrict ON UPDATE no action;
`,
  },
  {
    id: "0059_repoint_transaction_fk_to_run.sql",
    sql: `-- Re-point the transaction ledger off the agent onto the run that incurs a
-- charge. The table is unwritten (no producer), so there is no data to migrate
-- and no contract to preserve: rename agent_id to run_id and reference
-- workflow_run, keeping the nullable set-null delete so ledger history survives
-- the deletion of the run it references.
ALTER TABLE "transaction" RENAME COLUMN "agent_id" TO "run_id";
--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_agent_id_agent_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_run_id_workflow_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_run"("id") ON DELETE set null ON UPDATE no action;
`,
  },
  {
    id: "0060_drop_session_mail_instance_fk.sql",
    sql: `-- Drop session_mail's foreign key to agent_instance. instance_id becomes a
-- bare polymorphic column -- a legacy agent_instance id, or null for a folded
-- run -- mirroring inference_turn.instance_id (migration 0052). A folded run's
-- id comes from a shared id space that agent_instance does not contain, so no
-- single-table foreign key spans both.
ALTER TABLE "session_mail" DROP CONSTRAINT "session_mail_instance_id_agent_instance_id_fk";
`,
  },
  {
    id: "0061_drop_session_asset_instance_fk.sql",
    sql: `-- Drop session_asset's foreign key to agent_instance. instance_id becomes a
-- bare polymorphic column -- a legacy agent_instance id or a folded run id --
-- mirroring inference_turn.instance_id (migration 0052). A folded launch
-- already writes its workflow_run id here, which the agent_instance FK rejected,
-- so this also unblocks attaching assets to a folded run. instance_id stays NOT
-- NULL and part of the (instance_id, mount_path) primary key.
ALTER TABLE "session_asset" DROP CONSTRAINT "session_asset_instance_id_agent_instance_id_fk";
`,
  },
  {
    id: "0062_drop_agent_asset_table.sql",
    sql: `-- Drop the agent_asset table. Manual attach-to-an-agent was never wired,
-- so the table has no writer and is empty, and the launch-time direct
-- attachment path that read it is gone. session_asset's agent_asset_id
-- foreign key and its source column only distinguished direct attachments
-- from resolver-derived materializations; with the direct path gone every
-- row is resolver-derived, so both are dead. Drop the two columns first --
-- dropping agent_asset_id takes its foreign key with it -- so the table
-- has no remaining dependents when it goes (no CASCADE needed).
ALTER TABLE "session_asset" DROP COLUMN "agent_asset_id";--> statement-breakpoint
ALTER TABLE "session_asset" DROP COLUMN "source";--> statement-breakpoint
DROP TABLE "agent_asset";
`,
  },
  {
    id: "0063_repoint_agent_role_fk_to_definition.sql",
    sql: `-- Re-point the agent_role foreign key off the agent onto the folded workflow
-- definition. The column keeps its agent_id name, but its values become
-- workflow_definition ids: every agent was folded to exactly one definition,
-- linked by workflow_definition.origin_agent_id (a partial unique index, so
-- the join matches at most one definition). Role assignments follow the
-- definition so they survive the agent table's retirement.
--
-- The guard runs before any write. The production path applies migrations under
-- \`drizzle-kit migrate\`, which wraps the pending set in a transaction, and
-- PostgreSQL DDL is transactional, so an aborting guard rolls the whole set
-- back -- there is no partial commit to defend against. It aborts loudly if any
-- agent_role row references an agent with no folded definition, meaning the
-- agent fold has not run; the total fold makes that impossible in a folded
-- database, so the guard is a fail-loud assertion.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_role" ar
    WHERE NOT EXISTS (
      SELECT 1 FROM "workflow_definition" wd
      WHERE wd.origin_agent_id = ar.agent_id
    )
  ) THEN
    RAISE EXCEPTION 'agent_role row(s) reference an agent with no folded definition; run the agent fold (bin/db-backfill) before applying this migration';
  END IF;
END $$;
--> statement-breakpoint
-- Drop the old agent foreign key BEFORE rewriting the values: the rewrite sets
-- agent_id to a workflow_definition id, which is not an agent id, so it would
-- violate the still-active agent FK.
ALTER TABLE "agent_role" DROP CONSTRAINT "agent_role_agent_id_agent_id_fk";
--> statement-breakpoint
UPDATE "agent_role" ar
SET agent_id = wd.id
FROM "workflow_definition" wd
WHERE wd.origin_agent_id = ar.agent_id;
--> statement-breakpoint
ALTER TABLE "agent_role" ADD CONSTRAINT "agent_role_agent_id_workflow_definition_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workflow_definition"("id") ON DELETE cascade ON UPDATE no action;
`,
  },
  {
    id: "0064_repoint_agent_session_fk_to_definition.sql",
    sql: `-- Re-point the agent_session foreign key off the agent onto the folded
-- workflow definition. The column keeps its agent_id name, but its values
-- become workflow_definition ids: a launched session is keyed to the folded
-- definition it runs, so it survives the agent table's retirement. The delete
-- rule also changes -- cascade (on agent, from 0008) becomes restrict: session
-- history is an audit record, so a definition with live sessions must not be
-- droppable out from under them.
--
-- The guard runs before any write. The production path applies migrations under
-- \`drizzle-kit migrate\`, which wraps the pending set in a transaction, and
-- PostgreSQL DDL is transactional, so an aborting guard rolls the whole set
-- back -- there is no partial commit to defend against.
-- Unlike the offering (0058) and agent_role (0063) re-points, it guards the
-- AGENT table, not agent_session: the launch handler writes a fresh
-- agent_session row at runtime for an agent that may have no existing sessions,
-- so a child-table guard would pass vacuously for a never-launched unfolded
-- agent and the writer would then explode on its undefined definition id.
-- Every agent folded implies every session's agent folded, covering both this
-- historical rewrite and the runtime writer.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent" a
    WHERE NOT EXISTS (
      SELECT 1 FROM "workflow_definition" wd
      WHERE wd.origin_agent_id = a.id
    )
  ) THEN
    RAISE EXCEPTION 'agent(s) have no folded definition; run the agent fold (bin/db-backfill) before applying this migration';
  END IF;
END $$;
--> statement-breakpoint
-- Drop the old agent foreign key BEFORE rewriting the values: the rewrite sets
-- agent_id to a workflow_definition id, which is not an agent id, so it would
-- violate the still-active agent FK. agent_session's agent FK was written as a
-- raw inline REFERENCES in 0008, so Postgres auto-named it
-- agent_session_agent_id_fkey -- not the drizzle-style
-- agent_session_agent_id_agent_id_fk the snapshot infers.
ALTER TABLE "agent_session" DROP CONSTRAINT "agent_session_agent_id_fkey";
--> statement-breakpoint
UPDATE "agent_session" s
SET agent_id = wd.id
FROM "workflow_definition" wd
WHERE wd.origin_agent_id = s.agent_id;
--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_agent_id_workflow_definition_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workflow_definition"("id") ON DELETE restrict ON UPDATE no action;
`,
  },
  {
    id: "0065_add_workflow_definition_model_requirements.sql",
    sql: `-- Mirror each folded agent's model requirements onto its definition, so a
-- folded launch resolves its inference sources from the definition rather than
-- the agent row. The column is folded-only: null for a workflow-origin
-- definition, which carries no requirements manifest. A null/empty manifest is
-- legitimate -- it resolves to an unlaunchable empty source chain, exactly as
-- the agent field did -- so the copy preserves null verbatim and the column
-- takes no NOT NULL constraint.
--
-- Guard first: the backfill joins each folded definition to its agent over
-- origin_agent_id, a plain text column rather than an FK. If any folded
-- definition names an agent that does not exist, the join silently skips it and
-- its column stays null -- indistinguishable from a legitimately-null manifest.
-- Fail loud before writing so a broken back-reference surfaces here, not as a
-- mysteriously unlaunchable agent later. The production path applies migrations
-- under \`drizzle-kit migrate\`, which wraps the pending set in a transaction, and
-- PostgreSQL DDL is transactional, so an aborting guard rolls the whole set back
-- rather than leaving a half-applied backfill.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "workflow_definition" wd
    WHERE wd.origin_agent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "agent" a WHERE a.id = wd.origin_agent_id
      )
  ) THEN
    RAISE EXCEPTION 'folded definition(s) reference a missing agent; cannot backfill workflow_definition.model_requirements';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD COLUMN "model_requirements" jsonb;
--> statement-breakpoint
UPDATE "workflow_definition" wd
SET model_requirements = a.model_requirements
FROM "agent" a
WHERE wd.origin_agent_id = a.id;
`,
  },
  {
    id: "0066_rekey_agent_definition_principals_to_workflow.sql",
    sql: `-- Re-key each folded agent's actor identity onto the workflow model. A
-- definition-level agent principal's ref_id is the legacy agent id; the fold
-- moved that agent onto a workflow_definition, so its principal moves too --
-- kind agent -> workflow, ref_id agent.id -> definition.id. Afterwards the
-- folded agent's stable identity is a workflow-kind principal keyed by the
-- definition, and any grants it owns ride along under the new key untouched.
--
-- The mapping is 1:1 per tenant, which is what keeps the rewrite from
-- colliding on principal's UNIQUE(tenant_id, kind, ref_id): the partial-unique
-- index on workflow_definition.origin_agent_id admits at most one definition
-- per agent id, so no two agent principals collapse onto the same workflow key.
-- Existing workflow principals key on a run id, never a definition id, so the
-- re-keyed rows cannot collide with them either. The tenant predicate holds the
-- rewrite inside a single tenant even though agent ids are globally unique.
--
-- Only the definition-level class re-keys. An instance-level agent principal's
-- ref_id is an agent_instance id, which matches no origin_agent_id (disjoint id
-- spaces), so the join leaves it kind agent -- it retires later with the
-- agent_instance table it depends on. Idempotent: kind = 'agent' guards the
-- rewrite, and once it runs no definition principal remains agent-kind, so a
-- re-run is a no-op.
UPDATE "principal" p
SET kind = 'workflow', ref_id = wd.id
FROM "workflow_definition" wd
WHERE p.kind = 'agent'
  AND wd.origin_agent_id = p.ref_id
  AND wd.tenant_id = p.tenant_id;
`,
  },
  {
    id: "0067_add_workflow_definition_kind.sql",
    sql: `-- Classify each definition as a single-instance launch target (\`instance\`) or a
-- multi-step workflow deploy target (\`workflow\`), so the launch route can gate
-- on \`kind\` instead of \`origin_agent_id\` -- letting that column be dropped
-- later. Every folded (agent-origin) definition is an instance; a native
-- workflow-origin definition is a workflow. ADD COLUMN with a \`workflow\`
-- default sets every existing row to \`workflow\`; the backfill then flips the
-- folded rows, identified by a non-null origin_agent_id, to \`instance\`.
ALTER TABLE "workflow_definition" ADD COLUMN "kind" text DEFAULT 'workflow' NOT NULL;
--> statement-breakpoint
UPDATE "workflow_definition" SET "kind" = 'instance' WHERE "origin_agent_id" IS NOT NULL;
`,
  },
  {
    id: "0068_drop_agent_tables_and_origin_agent_id.sql",
    sql: `-- The fold onto workflow_definition/workflow_run is complete: nothing reads
-- the legacy agent tables or workflow_definition.origin_agent_id anymore. Drop
-- them. Child-first order (no CASCADE) so a bare DROP fails loudly if an
-- unmodelled dependent survives. The production path applies migrations under
-- \`drizzle-kit migrate\`, which wraps the pending set in a transaction, and
-- PostgreSQL DDL is transactional, so a guard's abort rolls the whole set back;
-- there is no partial-commit re-run-from-top mode. The IF EXISTS clauses keep
-- each drop tolerant of an already-absent relation regardless.
--
-- Guard first: agent_instance holds legacy routing, mail, and turn state that
-- the workflow-asset fold never converted into workflow_run (the fold projected
-- definitions from assets; it never migrated instances), and the fold tooling
-- has since been retired, so a bare DROP would destroy that state silently.
-- Abort while the table still holds rows so the loss is loud, not silent. The
-- to_regclass check keeps the file idempotent: on a re-run after the drop the
-- table is gone and the guard is skipped rather than erroring on a missing
-- relation.
DO $$
BEGIN
  IF to_regclass('agent_instance') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "agent_instance") THEN
      RAISE EXCEPTION 'agent_instance still holds rows: dropping the agent tables would destroy legacy agent routing, mail, and turn state that was never folded into workflow_run and has no automated conversion (the fold tooling has been retired). Retire the remaining agent instances by hand before applying this migration (see the agent-fold migration note in DEV.md).';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_instance";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_version";--> statement-breakpoint
DROP TABLE IF EXISTS "agent";--> statement-breakpoint
DROP INDEX IF EXISTS "workflow_definition_origin_agent_idx";--> statement-breakpoint
ALTER TABLE "workflow_definition" DROP COLUMN IF EXISTS "origin_agent_id";
`,
  },
  {
    id: "0069_drop_workflow_definition_kind.sql",
    sql: `-- The instance/workflow \`kind\` discriminator is redundant: a run already
-- classifies structurally (a plain routing address with a null deployment id is
-- an instance-shaped run; a deployment-anchored run carries its deployment id),
-- and the interactive-launch path gates on the presence of a model_requirements
-- manifest instead of kind. Drop the column. The production path applies
-- migrations under \`drizzle-kit migrate\`, which wraps the pending set in a
-- transaction, and PostgreSQL DDL is transactional, so an aborting migration
-- rolls back with no partial-commit re-run to defend against; the IF EXISTS
-- keeps the drop tolerant of an already-absent column regardless.
ALTER TABLE "workflow_definition" DROP COLUMN IF EXISTS "kind";`,
  },
  {
    id: "0070_flashy_proteus.sql",
    sql: `CREATE TABLE "workflow_run_execution" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"failure_reason" text
);
--> statement-breakpoint
ALTER TABLE "workflow_run_execution" ADD CONSTRAINT "workflow_run_execution_run_id_workflow_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_execution_run_id_id_idx" ON "workflow_run_execution" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "workflow_run_execution_status_idx" ON "workflow_run_execution" USING btree ("status");`,
  },
  {
    id: "0072_add_workflow_definition_credential_bindings.sql",
    sql: `ALTER TABLE "workflow_definition" ADD COLUMN "credential_bindings" jsonb;`,
  },
  {
    id: "0073_grant_target_exactly_one_check.sql",
    sql: `-- Every grant targets exactly one of a role or a principal. This CHECK is the
-- universal backstop: it holds for every insert path, including the internal
-- seeding and materialization sites that never touch the CreateGrant HTTP
-- validator. On the HTTP path, CreateGrant additionally enforces the same
-- exactly-one rule so a malformed POST is rejected with a 400 rather than
-- tripping this constraint as a 500.
--
-- On an existing database, ADD CONSTRAINT validates every row and FAILS LOUDLY
-- if a pre-existing grant carries both targets (or neither) -- rows a prior,
-- looser write path could have created. That is intentional: a both-target row
-- is ambiguous to auto-repair, so the migration surfaces it for manual
-- resolution rather than silently guessing which target to keep.
ALTER TABLE "grant" ADD CONSTRAINT "grant_target_exactly_one" CHECK (num_nonnulls("grant"."principal_id", "grant"."role_id") = 1);`,
  },
  {
    id: "0074_add_provider_api_base_url.sql",
    sql: `ALTER TABLE "provider" ADD COLUMN "api_base_url" text;`,
  },
  {
    id: "0075_workflow_run_launch_spec.sql",
    sql: `CREATE TABLE "workflow_run_launch_spec" (
	"anchor_run_id" text PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"session_id" text NOT NULL,
	"deployment_domain" text NOT NULL,
	"source_authority_principal_id" text NOT NULL,
	"definition_snapshot" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"source_offering_ids" jsonb NOT NULL,
	"default_source_offering_id" text NOT NULL,
	"deploy_content" jsonb NOT NULL,
	"tool_package_pins" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_run_launch_spec" ADD CONSTRAINT "workflow_run_launch_spec_anchor_run_id_workflow_run_id_fk" FOREIGN KEY ("anchor_run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_launch_spec" ADD CONSTRAINT "workflow_run_launch_spec_source_authority_principal_id_principal_id_fk" FOREIGN KEY ("source_authority_principal_id") REFERENCES "public"."principal"("id") ON DELETE restrict ON UPDATE no action;`,
  },
  {
    id: "0076_sidecar_allocation.sql",
    sql: `CREATE TABLE "sidecar_allocation" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_run_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"provisioner_id" text NOT NULL,
	"provisioner_api_version" integer NOT NULL,
	"provisioner_binding_fingerprint" text NOT NULL,
	"sidecar_id" text,
	"placement_sharing" text NOT NULL,
	"sidecar_reuse" text DEFAULT 'never' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"ensure_accepted_generation" integer,
	"external_ref" text,
	"next_attempt_at" timestamp,
	"reconciliation_lease_id" text,
	"reconciliation_lease_expires_at" timestamp,
	"ensure_attempts" integer DEFAULT 0 NOT NULL,
	"destroy_attempts" integer DEFAULT 0 NOT NULL,
	"connect_deadline" timestamp,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sidecar_allocation_status_check" CHECK ("sidecar_allocation"."status" in ('pending', 'provisioning', 'allocated', 'replacing', 'releasing', 'released', 'failed')),
	CONSTRAINT "sidecar_allocation_placement_check" CHECK ("sidecar_allocation"."placement_sharing" = 'exclusive'),
	CONSTRAINT "sidecar_allocation_generation_check" CHECK ("sidecar_allocation"."generation" >= 0),
	CONSTRAINT "sidecar_allocation_accepted_generation_check" CHECK ("sidecar_allocation"."ensure_accepted_generation" is null or "sidecar_allocation"."ensure_accepted_generation" <= "sidecar_allocation"."generation")
);
--> statement-breakpoint
ALTER TABLE "sidecar" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sidecar" ADD COLUMN "credential_scope" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "sidecar_allocation" ADD CONSTRAINT "sidecar_allocation_anchor_run_id_workflow_run_id_fk" FOREIGN KEY ("anchor_run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sidecar_allocation" ADD CONSTRAINT "sidecar_allocation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sidecar_allocation" ADD CONSTRAINT "sidecar_allocation_sidecar_id_sidecar_id_fk" FOREIGN KEY ("sidecar_id") REFERENCES "public"."sidecar"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sidecar_allocation_anchor_run_idx" ON "sidecar_allocation" USING btree ("anchor_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sidecar_allocation_active_sidecar_idx" ON "sidecar_allocation" USING btree ("sidecar_id") WHERE "sidecar_allocation"."status" in ('provisioning', 'allocated', 'replacing', 'releasing');--> statement-breakpoint
CREATE INDEX "sidecar_allocation_sidecar_idx" ON "sidecar_allocation" USING btree ("sidecar_id");--> statement-breakpoint
CREATE INDEX "sidecar_allocation_reconciliation_idx" ON "sidecar_allocation" USING btree ("next_attempt_at","created_at") WHERE "sidecar_allocation"."status" in ('pending', 'provisioning', 'allocated', 'replacing', 'releasing') and "sidecar_allocation"."next_attempt_at" is not null;--> statement-breakpoint
ALTER TABLE "sidecar" ADD CONSTRAINT "sidecar_credential_scope_check" CHECK ("sidecar"."credential_scope" in ('shared', 'allocated'));`,
  },
  {
    id: "0077_workflow_run_dispatch.sql",
    sql: `CREATE TABLE "workflow_run_dispatch" (
	"id" text PRIMARY KEY NOT NULL,
	"anchor_run_id" text NOT NULL,
	"message_id" text NOT NULL,
	"raw_message" "bytea" NOT NULL,
	"step_grants" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"acknowledged_generation" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now(),
	"delivery_lease_id" text,
	"delivery_lease_expires_at" timestamp,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp,
	"settled_at" timestamp,
	CONSTRAINT "workflow_run_dispatch_status_check" CHECK ("workflow_run_dispatch"."status" in ('pending', 'acknowledged', 'settled', 'failed')),
	CONSTRAINT "workflow_run_dispatch_attempt_count_check" CHECK ("workflow_run_dispatch"."attempt_count" >= 0),
	CONSTRAINT "workflow_run_dispatch_acknowledged_generation_check" CHECK ("workflow_run_dispatch"."acknowledged_generation" is null or "workflow_run_dispatch"."acknowledged_generation" >= 0),
	CONSTRAINT "workflow_run_dispatch_acknowledged_state_check" CHECK ("workflow_run_dispatch"."status" <> 'acknowledged' or "workflow_run_dispatch"."acknowledged_generation" is not null),
	CONSTRAINT "workflow_run_dispatch_pending_schedule_check" CHECK ("workflow_run_dispatch"."status" <> 'pending' or "workflow_run_dispatch"."next_attempt_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "workflow_run_dispatch" ADD CONSTRAINT "workflow_run_dispatch_anchor_run_id_workflow_run_id_fk" FOREIGN KEY ("anchor_run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_run_dispatch_anchor_message_idx" ON "workflow_run_dispatch" USING btree ("anchor_run_id","message_id");--> statement-breakpoint
CREATE INDEX "workflow_run_dispatch_delivery_idx" ON "workflow_run_dispatch" USING btree ("next_attempt_at","created_at") WHERE "workflow_run_dispatch"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "workflow_run_dispatch_anchor_status_idx" ON "workflow_run_dispatch" USING btree ("anchor_run_id","status");`,
  },
  {
    id: "0078_workflow_run_dispatch_kind.sql",
    sql: `ALTER TABLE "workflow_run_dispatch" ADD COLUMN "kind" text DEFAULT 'mail' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_dispatch" ADD CONSTRAINT "workflow_run_dispatch_kind_check" CHECK ("workflow_run_dispatch"."kind" in ('mail', 'signal'));`,
  },
  {
    id: "0079_rename_workflow_run_deployment_id_to_anchor_run_id.sql",
    sql: `ALTER TABLE "workflow_run" RENAME COLUMN "deployment_id" TO "anchor_run_id";--> statement-breakpoint
ALTER TABLE "workflow_run" DROP CONSTRAINT "workflow_run_deployment_id_workflow_run_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_anchor_run_id_workflow_run_id_fk" FOREIGN KEY ("anchor_run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0080_rename_correlation_approval_deployment_id_to_anchor_run_id.sql",
    sql: `ALTER TABLE "signal_correlation" RENAME COLUMN "deployment_id" TO "anchor_run_id";--> statement-breakpoint
ALTER TABLE "approval" RENAME COLUMN "deployment_id" TO "anchor_run_id";--> statement-breakpoint
ALTER TABLE "approval" DROP CONSTRAINT "approval_deployment_id_workflow_run_id_fk";
--> statement-breakpoint
ALTER TABLE "signal_correlation" DROP CONSTRAINT "signal_correlation_deployment_id_workflow_run_id_fk";
--> statement-breakpoint
ALTER INDEX "approval_deployment_idx" RENAME TO "approval_anchor_run_idx";--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_anchor_run_id_workflow_run_id_fk" FOREIGN KEY ("anchor_run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_correlation" ADD CONSTRAINT "signal_correlation_anchor_run_id_workflow_run_id_fk" FOREIGN KEY ("anchor_run_id") REFERENCES "public"."workflow_run"("id") ON DELETE cascade ON UPDATE no action;`,
  },
  {
    id: "0081_workflow_definition_content_hash_and_approved_wire_hash.sql",
    sql: `DROP INDEX "workflow_definition_asset_idx";--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD COLUMN "wire_hash" text;--> statement-breakpoint
ALTER TABLE "workflow_definition_version" ADD COLUMN "approved_wire_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_asset_wire_hash_idx" ON "workflow_definition" USING btree ("asset_id","wire_hash");`,
  },
  {
    id: "0082_blue_black_queen.sql",
    sql: `ALTER TABLE "workflow_definition_version" ADD COLUMN "grant_snapshot" jsonb;`,
  },
  {
    id: "0083_replace_launch_spec_snapshot_with_frozen_bundle.sql",
    sql: `ALTER TABLE "workflow_run_launch_spec" ADD COLUMN "frozen_approval_bundle" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_launch_spec" DROP COLUMN "definition_snapshot";--> statement-breakpoint
ALTER TABLE "workflow_run_launch_spec" DROP COLUMN "definition_hash";`,
  },
  {
    id: "0084_delete_orphaned_credential_grants.sql",
    sql: `-- Remove \`credential:{id}\` grant rows that reference a credential that no longer
-- exists. Before credential DELETE cleaned up its per-credential grants, deleting
-- a personal credential left its \`credential:{id}\` grant behind, and migration
-- 0037 backfilled the same shape for pre-existing personal credentials, so a
-- credential hard-deleted before that cleanup shipped left an orphaned grant.
--
-- The coarse wildcard \`credential:*\` role resource is excluded explicitly: no
-- credential has the id \`*\`, so the NOT EXISTS guard alone would wrongly match
-- it. There is no tenant scope: credential ids are globally unique, so an
-- orphaned grant is one whose id matches no credential in any tenant. This
-- removes every action on an orphaned resource, matching the credential DELETE
-- handler.
--
-- Idempotent: after this runs no orphaned row remains, so a re-run is a no-op.
DELETE FROM "grant"
WHERE "resource" LIKE 'credential:%'
  AND "resource" <> 'credential:*'
  AND NOT EXISTS (
    SELECT 1
    FROM "credential" c
    WHERE c."id" = substr("grant"."resource", length('credential:') + 1)
  );
`,
  },
  {
    id: "0085_add_approval_run_idx.sql",
    sql: `CREATE INDEX "approval_run_idx" ON "approval" USING btree ("run_id");`,
  },
  {
    id: "0086_cool_human_cannonball.sql",
    sql: `ALTER TABLE "workflow_run" ADD COLUMN "credential_refs" jsonb;`,
  },
  {
    id: "0087_drop_sidecar_placement.sql",
    sql: `ALTER TABLE "sidecar_allocation" DROP CONSTRAINT "sidecar_allocation_placement_check";--> statement-breakpoint
ALTER TABLE "sidecar_allocation" DROP COLUMN "placement_sharing";--> statement-breakpoint
ALTER TABLE "sidecar_allocation" DROP COLUMN "sidecar_reuse";`,
  },
  {
    id: "0088_thick_sprite.sql",
    sql: `CREATE TABLE "workflow_probe" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"definition_asset_id" text NOT NULL,
	"source" jsonb NOT NULL,
	"entry" text NOT NULL,
	"pin" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provisioner_id" text NOT NULL,
	"provisioner_api_version" integer NOT NULL,
	"provisioner_binding_fingerprint" text NOT NULL,
	"sidecar_id" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"external_ref" text,
	"result" jsonb,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_probe_status_check" CHECK ("workflow_probe"."status" in ('pending', 'provisioning', 'probing', 'releasing', 'succeeded', 'failed')),
	CONSTRAINT "workflow_probe_succeeded_result_check" CHECK ("workflow_probe"."status" <> 'succeeded' or "workflow_probe"."result" is not null),
	CONSTRAINT "workflow_probe_generation_check" CHECK ("workflow_probe"."generation" >= 0)
);
--> statement-breakpoint
DELETE FROM "sidecar" WHERE "credential_scope" = 'shared';--> statement-breakpoint
ALTER TABLE "sidecar" DROP CONSTRAINT "sidecar_credential_scope_check";--> statement-breakpoint
ALTER TABLE "workflow_probe" ADD CONSTRAINT "workflow_probe_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_probe" ADD CONSTRAINT "workflow_probe_definition_asset_id_asset_id_fk" FOREIGN KEY ("definition_asset_id") REFERENCES "public"."asset"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_probe" ADD CONSTRAINT "workflow_probe_sidecar_id_sidecar_id_fk" FOREIGN KEY ("sidecar_id") REFERENCES "public"."sidecar"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_probe_active_idx" ON "workflow_probe" USING btree ("created_at") WHERE "workflow_probe"."status" in ('pending', 'provisioning', 'probing', 'releasing');--> statement-breakpoint
CREATE INDEX "workflow_probe_sidecar_idx" ON "workflow_probe" USING btree ("sidecar_id");--> statement-breakpoint
ALTER TABLE "sidecar" DROP COLUMN "credential_scope";
`,
  },
  {
    id: "0089_tense_selene.sql",
    sql: `CREATE TABLE "principal_key" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_key_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
ALTER TABLE "principal_key" ADD CONSTRAINT "principal_key_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_key_one_active" ON "principal_key" USING btree ("principal_id") WHERE "principal_key"."status" = 'active';`,
  },
  {
    id: "0090_tenant_domain_lower_unique.sql",
    sql: `ALTER TABLE "tenant" DROP CONSTRAINT "tenant_domain_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_domain_lower_idx" ON "tenant" USING btree (lower("domain"));`,
  },
  {
    id: "0091_workflow_run_dispatch_sender_address.sql",
    sql: `ALTER TABLE "workflow_run_dispatch" ADD COLUMN "sender_address" text;--> statement-breakpoint
-- Fail in-flight mail dispatches that predate the authenticated-sender
-- requirement. They carry no persisted hub-verified sender, and neither
-- fabricating one nor re-reading the signed From is permitted, so they are
-- failed in place rather than delivered unauthenticated. Only unsettled
-- (pending/acknowledged) mail rows are ever re-dispatched and reconstruct a
-- mail.inbound frame; terminal (settled/failed) mail rows never do, so they
-- keep their NULL sender under the status-scoped check below. On a fresh
-- database this affects zero rows.
UPDATE "workflow_run_dispatch"
SET "status" = 'failed',
	"failure_code" = 'sender_address_migration',
	"failure_message" = 'in-flight mail dispatch predates the authenticated-sender requirement and carries no hub-verified sender',
	"next_attempt_at" = NULL,
	"delivery_lease_id" = NULL,
	"delivery_lease_expires_at" = NULL,
	"updated_at" = now()
WHERE "kind" = 'mail'
	AND "status" IN ('pending', 'acknowledged')
	AND "sender_address" IS NULL;--> statement-breakpoint
ALTER TABLE "workflow_run_dispatch" ADD CONSTRAINT "workflow_run_dispatch_mail_sender_check" CHECK ("workflow_run_dispatch"."kind" <> 'mail' or "workflow_run_dispatch"."status" in ('settled', 'failed') or "workflow_run_dispatch"."sender_address" is not null);
`,
  },
];
