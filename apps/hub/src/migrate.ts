/**
 * Forward-only migrations for the Builder schema.
 *
 * **No foreign key points into the hub's control plane.** `tenant_id` and
 * principal references are plain columns, because the hub can be a separate
 * service in another database — `SOLUTIONS_BUILDER_HUB_URL` makes that a
 * configuration choice. A cross-database foreign key is not expressible, so the
 * relationship is enforced where it can be: at the boundary that writes it.
 *
 * These run *after* Interchange's own migrations, which own the control plane
 * (`tenant`, `principal`, `grant`, `credential`, `workflow_*`). Builder adds
 * only what Interchange does not model — the nine-stage record, its approvals
 * and its artifact-graph lineage — and its foreign keys point into the hub's
 * tables rather than into a local stand-in.
 *
 * Each entry is applied once and stamped in `builder.migrations` with a
 * checksum of its statements, so an edited migration fails loudly on the next
 * start instead of silently diverging from the database it created.
 *
 * `@corbits/artifacts` owns its own schema and its own ledger; this runner
 * calls that package's migrator after ours, because its tables carry foreign
 * keys into the control-plane tables migration 0001 creates.
 */
import { sql, type SQL } from "drizzle-orm";
import { runArtifactMigrations } from "@corbits/artifacts";
import { BUILDER_SCHEMA } from "./schema.js";
import type { HostDatabase } from "./db.js";

type Migration = { readonly id: string; readonly statements: readonly SQL[] };

const MIGRATIONS: readonly Migration[] = [
  {
    // One migration, because there is nothing to migrate from. Nothing has
    // shipped, so the schema is a creation rather than a history of edits — a
    // reader should see what the Builder schema *is* without replaying
    // fourteen steps and mentally deleting the tables later dropped.
    // Interchange's own migrations run before this and own the control plane;
    // everything here is what Interchange does not model.
    //
    // The moment this reaches a machine that is not ours it stops being
    // editable, and every change after that is a new entry below it.
    id: "0001_builder_schema",
    statements: [

      sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(BUILDER_SCHEMA)}`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."project" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "title" text NOT NULL,
        "revision" integer NOT NULL DEFAULT 1,
        "active_branch_id" text,
        "policy" jsonb NOT NULL,
        "policy_version" integer NOT NULL DEFAULT 1,
        "archived_at" timestamptz,
        "deleted_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "project_tenant_idx"
        ON "builder"."project" ("tenant_id", "created_at")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."participant" (
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "principal_id" text NOT NULL,
        "role" text NOT NULL,
        "audience_name" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("project_id", "principal_id", "role")
      )`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."branch" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "name" text NOT NULL,
        "root_version_id" text,
        "archived_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE UNIQUE INDEX IF NOT EXISTS "branch_project_name_idx"
        ON "builder"."branch" ("project_id", "name")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."artifact_node" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "branch_id" text NOT NULL,
        "artifact_id" text NOT NULL,
        "version" integer NOT NULL,
        "kind" text NOT NULL,
        "stage" integer NOT NULL,
        "title" text NOT NULL,
        "media_type" text NOT NULL,
        "content_hash" text NOT NULL,
        "size_bytes" integer NOT NULL,
        "sink" text NOT NULL DEFAULT 'local',
        "producer_run_id" text,
        "provenance" jsonb NOT NULL,
        "superseded_by_node_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE UNIQUE INDEX IF NOT EXISTS "artifact_node_version_idx"
        ON "builder"."artifact_node" ("artifact_id", "version")`,

      sql`CREATE INDEX IF NOT EXISTS "artifact_node_project_stage_idx"
        ON "builder"."artifact_node" ("project_id", "stage")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."artifact_edge" (
        "child_node_id" text NOT NULL REFERENCES "builder"."artifact_node"("id") ON DELETE CASCADE,
        "source_node_id" text NOT NULL REFERENCES "builder"."artifact_node"("id") ON DELETE CASCADE,
        PRIMARY KEY ("child_node_id", "source_node_id")
      )`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."approval_record" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "run_id" text NOT NULL,
        "stage" integer NOT NULL,
        "command" text NOT NULL,
        "decision" text NOT NULL,
        "actor_principal_id" text NOT NULL,
        "authority" text NOT NULL,
        "audience_name" text,
        "versions" jsonb NOT NULL,
        "rationale" text,
        "assumptions" jsonb,
        "policy_version" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "approval_run_idx"
        ON "builder"."approval_record" ("run_id", "created_at")`,

      // One decision per audience per stage-5 run. A second submission from the
      // same audience is a conflict, not a silently accepted overwrite.
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "approval_audience_idx"
        ON "builder"."approval_record" ("run_id", "audience_name")
        WHERE "audience_name" IS NOT NULL`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."decision_flag" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "run_id" text NOT NULL,
        "trigger" text NOT NULL,
        "classification" text NOT NULL,
        "evidence" jsonb NOT NULL,
        "chosen_route" integer,
        "rejected_routes" jsonb,
        "resolved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."human_wait" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "run_id" text NOT NULL,
        "stage" integer NOT NULL,
        "title" text NOT NULL,
        "consequence" text NOT NULL,
        "required_authority" text NOT NULL,
        "versions" jsonb NOT NULL,
        "notified_at" timestamptz,
        "notify_error" text,
        "resolved_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "human_wait_open_idx"
        ON "builder"."human_wait" ("resolved_at", "created_at")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."build_packet" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "source_run_id" text NOT NULL,
        "versions" jsonb NOT NULL,
        "cost_approval" jsonb NOT NULL,
        "placement" text NOT NULL,
        "targets" jsonb NOT NULL,
        "packet_hash" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      // The freeze interlock, enforced by the database rather than by a check
      // that a future caller could forget: one frozen packet per run source.
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "build_packet_source_idx"
        ON "builder"."build_packet" ("source_run_id")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."build_question" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "run_id" text NOT NULL,
        "origin_id" text NOT NULL,
        "kind" text NOT NULL,
        "prompt" text NOT NULL,
        "scope_impact" jsonb,
        "deadline" timestamptz,
        "answered_at" timestamptz,
        "answer" text,
        "answered_by" text,
        "granted_capabilities" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "build_question_run_idx"
        ON "builder"."build_question" ("run_id", "answered_at")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."build_event" (
        "id" text PRIMARY KEY,
        "run_id" text NOT NULL,
        "idempotency_key" text NOT NULL,
        "cursor" integer NOT NULL,
        "type" text NOT NULL,
        "severity" text NOT NULL DEFAULT 'info',
        "payload" jsonb NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE UNIQUE INDEX IF NOT EXISTS "build_event_dedupe_idx"
        ON "builder"."build_event" ("run_id", "idempotency_key")`,

      sql`CREATE INDEX IF NOT EXISTS "build_event_cursor_idx"
        ON "builder"."build_event" ("run_id", "cursor")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."delivery_manifest" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "build_run_id" text NOT NULL,
        "descriptors" jsonb NOT NULL,
        "verification" jsonb NOT NULL,
        "actual_cost" jsonb,
        "exceptions" jsonb,
        "manifest_hash" text NOT NULL,
        "accepted_at" timestamptz,
        "accepted_by" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."audit_event" (
        "id" text PRIMARY KEY,
        "project_id" text,
        "actor_principal_id" text NOT NULL,
        "authority" text,
        "command" text NOT NULL,
        "transition_id" text,
        "correlation_id" text NOT NULL,
        "before" jsonb,
        "after" jsonb,
        "outcome" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "audit_project_idx"
        ON "builder"."audit_event" ("project_id", "created_at")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."outbox_entry" (
        "id" text PRIMARY KEY,
        "topic" text NOT NULL,
        "payload" jsonb NOT NULL,
        "correlation_id" text NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "delivered_at" timestamptz,
        "quarantined_at" timestamptz,
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "outbox_pending_idx"
        ON "builder"."outbox_entry" ("delivered_at", "created_at")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."command_receipt" (
        "idempotency_key" text PRIMARY KEY,
        "command_type" text NOT NULL,
        "result" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."host_preference" (
        "key" text PRIMARY KEY,
        "value" jsonb NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )`,

      // Stage 5 produces one package per audience. Without a discriminator they
      // would supersede one another, because a revision is keyed on kind.
      sql`ALTER TABLE "builder"."artifact_node" ADD COLUMN IF NOT EXISTS "variant" text`,

      sql`CREATE INDEX IF NOT EXISTS "artifact_node_variant_idx"
        ON "builder"."artifact_node" ("project_id", "kind", "variant")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."stage_question" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "branch_id" text NOT NULL,
        "stage" integer NOT NULL,
        "run_id" text NOT NULL,
        "source_node_id" text NOT NULL,
        "ordinal" integer NOT NULL,
        "body" text NOT NULL,
        "answer_message_id" text,
        "retired_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "stage_question_thread_idx"
        ON "builder"."stage_question" ("project_id", "branch_id", "stage")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."kit_record" (
        "kind" text NOT NULL,
        "key" text NOT NULL,
        "version" integer NOT NULL,
        "body" jsonb NOT NULL,
        "wire_hash" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("kind", "key", "version")
      )`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."agent_run_record" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "branch_id" text NOT NULL,
        "run_id" text NOT NULL,
        "stage" integer NOT NULL,
        "agent_id" text NOT NULL,
        "prompt_key" text NOT NULL,
        "prompt_version" integer NOT NULL,
        "model_key" text NOT NULL,
        "provider_id" text NOT NULL,
        "model" text NOT NULL,
        "input_version_ids" jsonb NOT NULL,
        "produced_node_id" text,
        "assumptions" jsonb NOT NULL,
        "questions" jsonb NOT NULL,
        "outcome" text NOT NULL,
        "failure" text,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "agent_run_record_project_idx"
        ON "builder"."agent_run_record" ("project_id", "stage")`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."compatibility_record" (
        "dependency" text PRIMARY KEY,
        "classification" text NOT NULL,
        "status" text NOT NULL,
        "revision" text,
        "version" text,
        "evidence" text NOT NULL,
        "limitations" jsonb NOT NULL,
        "checked_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE TABLE IF NOT EXISTS "builder"."change_notice" (
        "id" text PRIMARY KEY,
        "project_id" text NOT NULL REFERENCES "builder"."project"("id") ON DELETE CASCADE,
        "run_id" text NOT NULL,
        "raised_by" text NOT NULL,
        "summary" text NOT NULL,
        "scope_impact" jsonb NOT NULL,
        "decision" text,
        "decided_by" text,
        "route_target_stage" integer,
        "decided_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,

      sql`CREATE INDEX IF NOT EXISTS "change_notice_run_idx"
        ON "builder"."change_notice" ("run_id", "decided_at")`,

      // A local endpoint (Ollama) is the one connection kind the platform's
      // catalog cannot hold: `model_provider` requires exactly one of a
      // credential or a wallet, and a local endpoint has neither. Minting a
      // fake credential to satisfy that constraint would be a lie of
      // tidiness, so this record carries only what upstream cannot.
      sql`CREATE TABLE IF NOT EXISTS "builder"."local_provider" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "provider_id" text NOT NULL,
        "label" text NOT NULL,
        "base_url" text NOT NULL,
        "models" jsonb NOT NULL,
        "selected_model" text,
        "priority" integer NOT NULL DEFAULT 0,
        "validated_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "local_provider_idx"
        ON "builder"."local_provider" ("tenant_id", "provider_id")`,
    ],
  },
  {
    // The kit is code in the app package and the compatibility matrix was a
    // planning artifact; nothing read either. Change notices never had a
    // writer. Dropping them is the first cut toward a hub that holds only
    // what Interchange does not model.
    id: "0002_drop_planning_tables",
    statements: [
      sql`DROP TABLE IF EXISTS "builder"."kit_record"`,
      sql`DROP TABLE IF EXISTS "builder"."compatibility_record"`,
      sql`DROP TABLE IF EXISTS "builder"."change_notice"`,
    ],
  },
  {
    // CL-7573: `builder.local_provider` collapses into Interchange's own
    // catalog rows — the same `provider` / `credential` / `model_provider` /
    // `model` / `model_offering` tables every other connected provider lives
    // in, via a placeholder `credential` row tagged `{ keyless: true }` in
    // place of a real one (a local endpoint has no account and no key, and
    // `model_provider` requires exactly one of `credentialId`/`walletId`).
    //
    // This runs after Interchange's own migrations, so those tables already
    // exist. Every existing `local_provider` row is carried across — label,
    // base URL, discovered models, preference order, selected model — before
    // the table is dropped. IDs mirror exactly what `catalog.ts`'s
    // `registerProviderCatalog` and `ensureKeylessCredential` derive at
    // runtime, so a provider reconnected after this migration lands on the
    // same rows rather than a duplicate set.
    id: "0003_collapse_local_provider_into_catalog",
    statements: [
      sql.raw(`
        DO $$
        DECLARE
          r RECORD;
          model_name TEXT;
          idx INT;
          slug_provider TEXT;
          slug_model TEXT;
          prov_row_id TEXT;
          cred_id TEXT;
          cred_name TEXT;
          mpv_id TEXT;
          mdl_id TEXT;
          mof_id TEXT;
        BEGIN
          IF to_regclass('"builder"."local_provider"') IS NULL THEN
            RETURN;
          END IF;

          FOR r IN SELECT * FROM "builder"."local_provider" LOOP
            slug_provider := regexp_replace(regexp_replace(lower(r.provider_id), '[^a-z0-9]+', '-', 'g'), '(^-+)|(-+$)', '', 'g');
            prov_row_id := 'prv_' || regexp_replace(r.provider_id, '[^a-zA-Z0-9]+', '_', 'g');
            cred_name := 'provider:' || r.provider_id;
            cred_id := 'cred_' || regexp_replace(cred_name, '[^a-zA-Z0-9]+', '_', 'g');
            mpv_id := 'mpv_' || slug_provider;

            INSERT INTO "public"."provider"
              ("id","tenant_id","name","plugin","api_base_url","metadata","created_at","updated_at")
              VALUES (prov_row_id, r.tenant_id, r.provider_id, r.provider_id, r.base_url,
                      jsonb_build_object('label', r.label), now(), now())
              ON CONFLICT ("tenant_id","name") DO NOTHING;

            INSERT INTO "public"."credential"
              ("id","tenant_id","provider_id","name","type","description","secret","status","metadata","created_at","updated_at")
              VALUES (cred_id, r.tenant_id, prov_row_id, cred_name, 'other',
                      'Placeholder for a keyless local endpoint — carries no secret material.',
                      'keyless:no-credential-required', 'active', jsonb_build_object('keyless', true),
                      now(), COALESCE(r.validated_at, now()))
              ON CONFLICT ("tenant_id","name") DO NOTHING;

            INSERT INTO "public"."model_provider"
              ("id","tenant_id","name","plugin","base_url","credential_id","wallet_id","disabled","created_at","updated_at")
              VALUES (mpv_id, r.tenant_id, slug_provider, 'openai-compatible', r.base_url, cred_id, NULL, false, now(), now())
              ON CONFLICT ("tenant_id","name") DO NOTHING;

            idx := 0;
            FOR model_name IN SELECT jsonb_array_elements_text(r.models) LOOP
              slug_model := regexp_replace(regexp_replace(lower(model_name), '[^a-z0-9]+', '-', 'g'), '(^-+)|(-+$)', '', 'g');
              mdl_id := 'mdl_' || slug_model;
              mof_id := 'mof_' || slug_model || '-' || slug_provider;

              INSERT INTO "public"."model"
                ("id","tenant_id","canonical_name","display_name","disabled","created_at","updated_at")
                VALUES (mdl_id, r.tenant_id, model_name, model_name, false, now(), now())
                ON CONFLICT ("tenant_id","canonical_name") DO NOTHING;

              -- Priority mirrors registerProviderCatalog's scheme (base
              -- priority * 1000 + discovery order). Capabilities are left
              -- empty: the honest fallback for a model this build has not
              -- probed for anything beyond its name.
              INSERT INTO "public"."model_offering"
                ("id","tenant_id","model_id","provider_id","priority","deployment_tags","capabilities","quirks","disabled","created_at","updated_at")
                VALUES (mof_id, r.tenant_id, mdl_id, mpv_id, r.priority * 1000 + idx, '{}', '{}', NULL,
                        (r.selected_model IS NOT NULL AND r.selected_model <> model_name), now(), now())
                ON CONFLICT ("tenant_id","model_id","provider_id") DO NOTHING;

              idx := idx + 1;
            END LOOP;
          END LOOP;
        END $$;
      `),
      sql`DROP TABLE IF EXISTS "builder"."local_provider"`,
    ],
  },
  {
    // The open decision is derived from the parked run and the ledger, and the
    // open question from the specialist's own turn in the thread. Neither
    // needs a row beside the record it restated.
    id: "0004_drop_wait_and_question_tables",
    statements: [
      sql`DROP TABLE IF EXISTS "builder"."human_wait"`,
      sql`DROP TABLE IF EXISTS "builder"."stage_question"`,
    ],
  },
  {
    // Start-at-login is a marker file the shell reads before the database
    // opens; design feedback is a version on the feedback artifact.
    // Approvals, audit and receipts are turns in the project ledger thread;
    // effects fire after commit instead of through an outbox.
    id: "0005_drop_preference_and_record_tables",
    statements: [
      sql`DROP TABLE IF EXISTS "builder"."host_preference"`,
      sql`DROP TABLE IF EXISTS "builder"."approval_record"`,
      sql`DROP TABLE IF EXISTS "builder"."audit_event"`,
      sql`DROP TABLE IF EXISTS "builder"."outbox_entry"`,
      sql`DROP TABLE IF EXISTS "builder"."command_receipt"`,
    ],
  },
];

async function checksum(migration: Migration): Promise<string> {
  const text = migration.statements.map((statement) => statement.queryChunks.join("")).join(";");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class MigrationDriftError extends Error {}

/**
 * Establishes the whole schema, in the only order that works: Interchange owns
 * the control plane, Builder's foreign keys point into it, and the artifact
 * package's point into both.
 *
 * Every entry point — the host, the smokes, the seeds — calls this rather than
 * remembering the order itself.
 */
/**
 * Points Builder's tenant and principal columns at the hub's own tables.
 *
 * Authority is Interchange's to own, so the rows that carry it should be the
 * ones the hub already has: a tenant Builder invented, or a principal it kept
 * after the hub forgot it, is a second authorisation story that only diverges.
 *
 * Embedded only, and added after the fact rather than in the table's own
 * migration, because these are cross-schema references: with a hosted hub the
 * control plane is a different database and the constraint cannot exist. The
 * columns are the same either way; what changes is whether the database can
 * enforce them, and that is a property of the deployment, not of the schema.
 */
async function linkAuthzToHub(host: HostDatabase): Promise<void> {
  const constraints: { table: string; column: string; target: string; name: string }[] = [
    { table: "project", column: "tenant_id", target: "tenant", name: "project_tenant_fk" },
    { table: "participant", column: "principal_id", target: "principal", name: "participant_principal_fk" },
  ];

  for (const constraint of constraints) {
    // `NOT VALID` so an existing workspace with rows predating the hub is not
    // refused at upgrade time; new rows are checked from here on. Adding a
    // constraint must never be the thing that stops somebody opening their
    // own project.
    await host.db
      .execute(
        sql.raw(
          `DO $$ BEGIN
             ALTER TABLE "builder"."${constraint.table}"
               ADD CONSTRAINT "${constraint.name}"
               FOREIGN KEY ("${constraint.column}")
               REFERENCES "public"."${constraint.target}"("id")
               NOT VALID;
           EXCEPTION
             WHEN duplicate_object THEN NULL;
             WHEN undefined_table THEN NULL;
           END $$;`,
        ),
      )
      .catch(() => {
        // A hub schema that is not there yet is not an error worth failing a
        // boot over; the next start adds the constraint.
      });
  }
}

export async function prepareDatabase(
  host: HostDatabase,
): Promise<{ interchange: number; builder: string[] }> {
  const { hubMode } = await import("./hub-client.js");

  // A hosted hub owns its own schema and its own database. Applying
  // Interchange's migrations locally in that mode would create a second,
  // divergent control plane — the exact thing the hub exists to prevent.
  let interchange = 0;
  if (hubMode() === "embedded") {
    const { migrateHub } = await import("./hub-migrate.js");
    interchange = (await migrateHub(host)).applied.length;
  }

  const builder = await migrate(host);
  return { interchange, builder: builder.applied };
}

export async function migrate(host: HostDatabase): Promise<{ applied: string[] }> {
  const { db } = host;
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(BUILDER_SCHEMA)}`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "builder"."migrations" (
    "id" text PRIMARY KEY,
    "checksum" text NOT NULL,
    "applied_at" timestamptz NOT NULL DEFAULT now()
  )`);

  const existing = await db.execute<{ id: string; checksum: string }>(
    sql`SELECT "id", "checksum" FROM "builder"."migrations"`,
  );
  const stamped = new Map(
    (existing.rows as { id: string; checksum: string }[]).map((row) => [row.id, row.checksum]),
  );

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    const digest = await checksum(migration);
    const previous = stamped.get(migration.id);
    if (previous !== undefined) {
      if (previous !== digest) {
        throw new MigrationDriftError(
          `Migration ${migration.id} changed after it was applied. ` +
            `Add a new migration instead of editing a stamped one.`,
        );
      }
      continue;
    }
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) await tx.execute(statement);
      await tx.execute(
        sql`INSERT INTO "builder"."migrations" ("id","checksum") VALUES (${migration.id}, ${digest})`,
      );
    });
    applied.push(migration.id);
  }

  // `@corbits/artifacts` foreign-keys into `public.tenant` and
  // `public.principal`, so its tables can only exist where the control plane
  // does. With an embedded hub that is this database. With a hosted hub it is
  // not, and artifact storage has to move to the hub alongside it. That is
  // future work, not papered over with a second control plane here.
  const { hubMode } = await import("./hub-client.js");
  if (hubMode() === "embedded") {
    await runArtifactMigrations(host.artifactDb);
    await linkAuthzToHub(host);
  }

  return { applied };
}
