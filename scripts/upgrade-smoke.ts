/**
 * Upgrade smoke: what happens on the *second* run.
 *
 * Every other test in this repository starts from an empty directory, which is
 * why two upgrade defects reached the operator instead of a gate:
 *
 *   1. a workspace created before the Interchange hub was mounted crashed on
 *      launch with `42P07 relation "tenant" already exists`;
 *   2. the check that was supposed to catch it was gated on an empty migration
 *      ledger, so a partially-applied run skipped it — exactly the case it
 *      existed for.
 *
 * A fresh-install test cannot find either. This one builds databases in known
 * prior states and runs the real migrator against them.
 *
 * Usage: bun --conditions intx-src scripts/upgrade-smoke.ts
 */
import "./smoke-env.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { withPostgresJsResultShape } from "../apps/hub/src/pg-compat.js";
import { HUB_MIGRATIONS } from "../apps/hub/src/hub-migrations.js";
import { migrateHub, PreHubDatabaseError } from "../apps/hub/src/hub-migrate.js";
import { openDatabase, type HostDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { catalog, ensureHub, getTenant, hubGet, tenantId } from "../apps/hub/src/hub-client.js";
import { hub } from "../apps/hub/src/hub-mount.js";
import { resolveCredentialSecret } from "../apps/hub/src/hub-gaps.js";
import { install, installState } from "../apps/hub/src/installer-bridge.js";
import { readSecretResult, secretReference, storeSecret } from "../apps/hub/src/host-secrets.js";
import { migrateLegacyProviderCredentials } from "../apps/hub/src/credential-migration.js";
import { expectedDefinitions } from "@solutions-builder/app/manifest";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

async function open(dir: string): Promise<HostDatabase & { close: () => Promise<void> }> {
  const client = await PGlite.create(dir);
  const db = drizzle(client);
  return {
    db: db as never,
    raw: client,
    artifactDb: withPostgresJsResultShape(db) as never,
    close: async () => client.close(),
  };
}

const roots: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sb-upgrade-"));
  roots.push(dir);
  return join(dir, "pglite");
}

try {
  // --- A workspace from before the hub existed ---
  {
    const dir = await scratch();
    const host = await open(dir);
    // The control-plane stand-in this build used to carry, verbatim.
    await host.raw.exec(`
      CREATE TABLE "public"."tenant" (
        "id" text PRIMARY KEY, "name" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "public"."principal" (
        "id" text PRIMARY KEY, "tenant_id" text, "kind" text NOT NULL,
        "display_name" text NOT NULL
      );
      INSERT INTO "public"."tenant" VALUES ('t_local', 'Local workspace', now());
    `);

    let refused: unknown;
    await migrateHub(host).catch((cause: unknown) => {
      refused = cause;
    });

    check(
      "a pre-hub workspace is refused, not crashed through",
      refused instanceof PreHubDatabaseError,
      refused instanceof Error ? refused.name : "no error raised",
    );
    check(
      "the refusal says what to do about it",
      refused instanceof Error &&
        refused.message.includes("SOLUTIONS_BUILDER_DATA_DIR") &&
        refused.message.includes("rm -rf"),
    );
    // The point of refusing rather than dropping: the data is still there.
    const rows = await host.db.execute<{ id: string }>(sql`SELECT id FROM "public"."tenant"`);
    check(
      "the refusal changes nothing",
      (rows.rows as { id: string }[])[0]?.id === "t_local",
    );
    await host.close();
  }

  // --- Applying and recording are one step ---
  //
  // The failure that reached the operator was a database carrying tables that
  // the ledger did not account for. That state is only reachable if a run can
  // stop between applying a migration and stamping it, so the property to hold
  // is that it cannot.
  {
    const dir = await scratch();
    const host = await open(dir);

    // Interrupt for real: a table one of the later migrations creates already
    // exists, so that migration fails partway through its own script.
    await host.raw.exec(`CREATE TABLE "public"."wallet" ("id" text PRIMARY KEY);`);

    let threw = false;
    await migrateHub(host).catch(() => {
      threw = true;
    });
    check("a migration that cannot apply fails loudly", threw);

    const stamped = await host.db.execute<{ id: string }>(
      sql`SELECT "id" FROM "interchange_migrations"`,
    );
    const ids = (stamped.rows as { id: string }[]).map((row) => row.id);

    // Every stamped migration must have actually applied. The one that failed
    // must not be recorded, and its partial work must not survive.
    const tables = await host.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `);
    const names = new Set((tables.rows as { table_name: string }[]).map((row) => row.table_name));

    check(
      "the failed migration is not recorded as applied",
      !ids.includes("0000_brown_wither.sql") || names.has("tenant"),
      `${ids.length} stamped`,
    );
    check(
      "a failed migration leaves nothing behind",
      // `federation_trust` is created by the same script as `tenant`; if the
      // script rolled back, neither exists.
      names.has("tenant") === names.has("federation_trust"),
    );
    await host.close();
  }

  // --- The ordinary case: launching twice ---
  {
    const dir = await scratch();
    const first = await open(dir);
    const initial = await migrateHub(first);
    await first.close();

    const second = await open(dir);
    const again = await migrateHub(second);
    await second.close();

    // Counted from the embedded set rather than written down: refreshing the
    // vendored Interchange changes this number, and a literal here would fail
    // the gate for the wrong reason and teach people to edit the number.
    check(
      "a first run applies the hub schema",
      initial.applied.length === HUB_MIGRATIONS.length,
      `${initial.applied.length} of ${HUB_MIGRATIONS.length}`,
    );
    check("a second run applies nothing", again.applied.length === 0, `${again.applied.length}`);
  }
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true });
}


// A workspace stamped by an earlier vendored revision: the ledger claims a
// migration ran, this revision has different SQL under that id, and the
// failure surfaces later as an ALTER against a table nothing created. The
// person must be told what happened and what to do, not handed a driver dump.
{
  const stale = await open(await scratch());

  // Stamp a mid-list migration as applied without running it — exactly the
  // state a revision change leaves behind.
  await stale.raw.exec(`CREATE TABLE IF NOT EXISTS "interchange_migrations" (
    "id" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`);
  const skipped = HUB_MIGRATIONS[Math.floor(HUB_MIGRATIONS.length / 2)]!;
  await stale.raw.exec(
    `INSERT INTO "interchange_migrations" ("id") VALUES ('${skipped.id.replace(/'/g, "''")}')`,
  );

  let failure: unknown = null;
  await migrateHub(stale).catch((cause: unknown) => {
    failure = cause;
  });

  check(
    "a workspace from an earlier revision fails loudly rather than part-way",
    failure !== null,
    failure === null ? "it appeared to succeed" : "refused",
  );
  check(
    "and says so in words, naming the migration and the way out",
    failure instanceof PreHubDatabaseError &&
      failure.message.includes("earlier vendored revision") &&
      failure.message.includes("rm -rf"),
    failure instanceof Error ? failure.message.split("\n")[0]!.slice(0, 60) : "",
  );
  await stale.close();
}

// --- Boot is vanilla; the client installs ---
//
// A workspace that has booted holds no product definitions until it is asked
// to. The ask is idempotent, so upgrading is the same call as installing.
{
  const dir = await mkdtemp(join(tmpdir(), "sb-upgrade-"));
  roots.push(dir);
  const host = await openDatabase(join(dir, "pglite"));
  await prepareDatabase(host);
  await ensureHub();

  const before = await installState();
  check("a booted workspace is not installed", !before.installed);
  check(
    "and every definition is reported missing",
    before.missing.length === expectedDefinitions().length,
    `${before.missing.length}`,
  );

  const count = async () => {
    const rows = await (hub().db.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> })
      .execute(sql`SELECT id FROM "public"."workflow_definition"`);
    return rows.rows.length;
  };

  const after = await install();
  check("install brings it to installed", after.installed && after.missing.length === 0, after.detail);
  const definitions = await count();
  check("every expected definition exists", definitions === expectedDefinitions().length, `${definitions}`);

  const again = await install();
  check("a second install is a no-op", again.installed && (await count()) === definitions);

  // --- installer-bridge.ts: the host's own tenant cache must not go stale ---
  //
  // `hub-client.ts` caches the resolved workspace independently of the
  // installer package's own cache, and every other per-request call in the
  // hub reads that cache, not the package's. Simulate the workspace tenant
  // being replaced under the same owner — the first tenant's slug moved
  // aside, a second tenant carrying the workspace slug given the same
  // owner principal, exactly what a data repair or a re-adopted legacy
  // tenant would leave behind — then install again. A stale `hub-client.ts`
  // cache would keep every later `tenantId()` call answering with the first
  // tenant forever, since its own `resolveWorkspace()` short-circuits on a
  // cached value and never asks the hub again.
  {
    const firstTenantId = tenantId();
    const me = await hubGet<{ id: string }>("/api/me");
    await host.db.execute(sql`UPDATE "public"."tenant" SET "slug" = 'solutions-builder-superseded' WHERE "id" = ${firstTenantId}`);
    await host.db.execute(sql`
      INSERT INTO "public"."tenant" ("id","name","slug","domain")
      VALUES ('t_superseding', 'Solutions Builder', 'solutions-builder', 'superseding.solutions-builder.invalid')
    `);
    await host.db.execute(sql`
      INSERT INTO "public"."principal" ("id","tenant_id","kind","ref_id","status")
      VALUES ('principal_superseding_owner', 't_superseding', 'user', ${me.id}, 'active')
    `);
    // `POST /api/tenants` bootstraps the creator as the tenant's owner (a
    // role plus an allow-everything grant); a tenant assembled by hand, the
    // same way `adoptLegacyWorkspace` (`hub-gaps.ts`) repairs one, needs the
    // same two rows or every write below is refused as unauthorised.
    await host.db.execute(sql`
      INSERT INTO "public"."role" ("id","tenant_id","name","description","is_system")
      VALUES ('role_owner_t_superseding', 't_superseding', 'owner', 'System owner role', true)
    `);
    await host.db.execute(sql`
      INSERT INTO "public"."grant" ("id","tenant_id","role_id","resource","action","effect","origin")
      VALUES ('grant_owner_t_superseding', 't_superseding', 'role_owner_t_superseding', '*', '*', 'allow', 'system')
    `);
    await host.db.execute(sql`
      INSERT INTO "public"."principal_role" ("principal_id","role_id")
      VALUES ('principal_superseding_owner', 'role_owner_t_superseding')
    `);
    // The lifecycle definition's id is content-derived, not tenant-scoped, so
    // the first tenant's row would collide on the primary key once the same
    // package installs the same definition into the second tenant. The first
    // tenant is superseded, not a survivor this test cares about; clearing its
    // row is the honest way around a schema property this test does not
    // exist to exercise.
    await host.db.execute(sql`DELETE FROM "public"."workflow_definition" WHERE "tenant_id" = ${firstTenantId}`);

    const reinstalled = await install();
    check("install follows the tenant now carrying the workspace slug", reinstalled.installed, reinstalled.detail);
    check(
      "the host's own tenant scope follows it too, not a stale earlier resolution",
      tenantId() === "t_superseding",
      tenantId(),
    );
  }

  // --- CL-8076: a pre-upgrade OAuth secret in the old keychain/file store is
  // carried into the hub's own credential row, once, on boot. ---
  //
  // The OAuth case is the one this migration exists to fix: pre-CL-8076 code
  // sealed a useless keychain-reference *string* into the credential row's
  // `secret` column (the real tokens lived only in the keychain), so the row
  // existed but could not have authenticated anything. Seeded here exactly
  // that way, then `install()` — which runs the migration once the workspace
  // is resolvable — must overwrite the row with the real tokens and delete
  // the old keychain entry.
  {
    const legacyProviderId = "codex-oauth";
    const legacyAccount = `oauth:${legacyProviderId}`;
    const realTokens = JSON.stringify({ access: "at-legacy", refresh: "rt-legacy", expiresAt: 0 });
    await storeSecret(legacyAccount, realTokens);

    const legacyProvider = await catalog.createProvider({
      name: legacyProviderId,
      plugin: legacyProviderId,
      apiBaseUrl: "https://chatgpt.com/backend-api/codex",
      metadata: { label: "ChatGPT (Codex)" },
    });
    await catalog.createCredential({
      providerId: legacyProvider.id,
      name: `provider:${legacyProviderId}`,
      type: "oauth_token",
      // The useless pointer pre-CL-8076 code sealed here instead of real
      // material — `upsertCredential` had no `secret` to fall back to.
      secret: `keychain:${legacyAccount}`,
      description: "pre-migration placeholder",
    });

    const beforeMigration = await readSecretResult(await secretReference(legacyAccount));
    check("the legacy keychain entry exists before migration", beforeMigration.status === "found");

    await install();

    const credentialRows = await (
      hub().db.db as unknown as { execute: (q: unknown) => Promise<{ rows: { id: string }[] }> }
    ).execute(sql`SELECT "id" FROM "public"."credential" WHERE "name" = ${`provider:${legacyProviderId}`}`);
    const credentialId = credentialRows.rows[0]?.id;
    check("the credential row still exists after migration", typeof credentialId === "string");

    const decrypted = credentialId ? await resolveCredentialSecret(credentialId) : null;
    check(
      "the credential row now carries the real tokens, not the old pointer",
      decrypted === realTokens,
      String(decrypted),
    );

    const afterMigration = await readSecretResult(await secretReference(legacyAccount));
    check(
      "the old keychain entry is gone after migration",
      afterMigration.status === "missing",
    );

    const tenantConfig = (await getTenant(tenantId()))?.config as
      | { credentialMigration?: { mappings: { account: string; credentialId: string }[] } }
      | undefined;
    const mappings = tenantConfig?.credentialMigration?.mappings ?? [];
    check(
      "the migration is recorded on the workspace tenant's config",
      mappings.some((entry) => entry.account === legacyAccount && entry.credentialId === credentialId),
      JSON.stringify(mappings),
    );

    await install();
    const tenantConfigAgain = (await getTenant(tenantId()))?.config as
      | { credentialMigration?: { mappings: { account: string; credentialId: string }[] } }
      | undefined;
    check(
      "running the migration again is a no-op, not a duplicate mapping",
      (tenantConfigAgain?.credentialMigration?.mappings ?? []).length === mappings.length,
    );
  }

  // --- CL-8076: the API-key case — the row already carried the real secret ---
  //
  // Pre-CL-8076 code sealed the real key into the credential row for an
  // API-key connection (only the OAuth row was ever a useless pointer), so
  // this account's migration is a no-op on the row and a straight cleanup of
  // the old keychain entry.
  {
    const legacyProviderId = "anthropic";
    const legacyAccount = `provider:${legacyProviderId}`;
    const realKey = "sk-ant-legacy-real-key";
    await storeSecret(legacyAccount, realKey);

    const legacyProvider = await catalog.createProvider({
      name: legacyProviderId,
      plugin: legacyProviderId,
      apiBaseUrl: "https://api.anthropic.com/v1",
      metadata: { label: "Anthropic" },
    });
    await catalog.createCredential({
      providerId: legacyProvider.id,
      name: legacyAccount,
      type: "api_key",
      secret: realKey,
      description: "already real, pre-migration",
    });

    await install();

    const credentialRows = await (
      hub().db.db as unknown as { execute: (q: unknown) => Promise<{ rows: { id: string }[] }> }
    ).execute(sql`SELECT "id" FROM "public"."credential" WHERE "name" = ${legacyAccount}`);
    const credentialId = credentialRows.rows[0]?.id;
    const decrypted = credentialId ? await resolveCredentialSecret(credentialId) : null;
    check(
      "an API-key row that already carried the real secret still does after migration",
      decrypted === realKey,
      String(decrypted),
    );

    const afterMigration = await readSecretResult(await secretReference(legacyAccount));
    check("its old keychain entry is deleted too", afterMigration.status === "missing");
  }

  // --- CL-8076: an orphaned legacy secret — no matching credential row ---
  //
  // A secret can still be in the old store with nothing on the platform side
  // to carry it into (a row deleted separately, or a store left over from an
  // even older build). Migrating must leave it alone rather than discard it.
  {
    const orphanProviderId = "openrouter";
    const orphanAccount = `provider:${orphanProviderId}`;
    await storeSecret(orphanAccount, "sk-orphan-should-not-move");

    await install();

    const stillThere = await readSecretResult(await secretReference(orphanAccount));
    check(
      "an orphaned legacy secret with no matching credential row is left alone",
      stillThere.status === "found",
    );

    const tenantConfig = (await getTenant(tenantId()))?.config as
      | { credentialMigration?: { mappings: { account: string }[] } }
      | undefined;
    check(
      "and it is not recorded as migrated",
      !(tenantConfig?.credentialMigration?.mappings ?? []).some((entry) => entry.account === orphanAccount),
    );
  }

  // --- CL-8076: one account's failure must not stop the others ---
  //
  // `catalog.patchCredential` is stubbed to fail for exactly one of two
  // otherwise-identical legacy accounts, standing in for a hub that rejects
  // one account's patch (a transient fault, a locked row). The other account
  // must still migrate, and the failure must be reported rather than thrown
  // past the loop.
  {
    const okProviderId = "xai";
    const okAccount = `provider:${okProviderId}`;
    const okSecret = "sk-xai-legacy-real-key";
    await storeSecret(okAccount, okSecret);
    const okProvider = await catalog.createProvider({
      name: okProviderId,
      plugin: okProviderId,
      apiBaseUrl: "https://api.x.ai/v1",
      metadata: { label: "xAI" },
    });
    const okCredential = await catalog.createCredential({
      providerId: okProvider.id,
      name: okAccount,
      type: "api_key",
      secret: "stale-pre-migration-value",
      description: "pre-migration",
    });

    const failProviderId = "compatible";
    const failAccount = `provider:${failProviderId}`;
    await storeSecret(failAccount, "sk-compatible-legacy-real-key");
    const failProvider = await catalog.createProvider({
      name: failProviderId,
      plugin: failProviderId,
      apiBaseUrl: "http://localhost:1234/v1",
      metadata: { label: "Compatible" },
    });
    const failCredential = await catalog.createCredential({
      providerId: failProvider.id,
      name: failAccount,
      type: "api_key",
      secret: "stale-pre-migration-value",
      description: "pre-migration",
    });

    const originalPatchCredential = catalog.patchCredential;
    catalog.patchCredential = (id, input) => {
      if (id === failCredential.id) {
        return Promise.reject(new Error("simulated hub rejection for the failure-path test"));
      }
      return originalPatchCredential(id, input);
    };

    let result: Awaited<ReturnType<typeof migrateLegacyProviderCredentials>>;
    try {
      result = await migrateLegacyProviderCredentials();
    } finally {
      catalog.patchCredential = originalPatchCredential;
    }

    check(
      "a failing account is reported as a failure, not thrown past the loop",
      result.failures.some((entry) => entry.account === failAccount),
      JSON.stringify(result.failures),
    );
    check(
      "the other account still migrates despite the failure",
      result.migrated.some((entry) => entry.account === okAccount && entry.credentialId === okCredential.id),
      JSON.stringify(result.migrated),
    );

    const okStillThere = await readSecretResult(await secretReference(okAccount));
    check("the succeeding account's old entry is deleted", okStillThere.status === "missing");

    const failStillThere = await readSecretResult(await secretReference(failAccount));
    check(
      "the failing account's old entry is left in place, safe to retry",
      failStillThere.status === "found",
    );

    // The retry itself: with the stub removed, the next run finishes what
    // the simulated failure interrupted.
    const retried = await migrateLegacyProviderCredentials();
    check(
      "retrying after the failure migrates the previously-failing account",
      retried.migrated.some((entry) => entry.account === failAccount && entry.credentialId === failCredential.id),
      JSON.stringify(retried.migrated),
    );
    const failGoneAfterRetry = await readSecretResult(await secretReference(failAccount));
    check("and its old entry is finally deleted", failGoneAfterRetry.status === "missing");
  }

  await host.close();
}

// --- CL-7573: a `local_provider` row from before the collapse survives it ---
//
// A workspace connected a local endpoint before `builder.local_provider`
// collapsed into Interchange's own catalog rows. The migration must carry
// that row across — label, base URL, models, priority, selected model — and
// the table must be gone afterward.
{
  const dir = await mkdtemp(join(tmpdir(), "sb-upgrade-"));
  roots.push(dir);
  const host = await openDatabase(join(dir, "pglite"));

  // Real Interchange tables first, exactly like a live upgrade would have.
  await migrateHub(host);

  // The workspace tenant `local_provider.tenant_id` used to point at, seeded
  // the way `ensureWorkspace` does it.
  await host.db.execute(sql`
    INSERT INTO "public"."tenant" ("id","name","slug","domain")
    VALUES ('t_local', 'Local workspace', 'local', 'local.solutions-builder.invalid')
    ON CONFLICT ("id") DO NOTHING
  `);

  // The pre-collapse table, seeded with a connected local endpoint — verbatim
  // the shape migration 0001 creates, before 0003 ever ran.
  await host.raw.exec(`
    CREATE SCHEMA IF NOT EXISTS "builder";
    CREATE TABLE IF NOT EXISTS "builder"."local_provider" (
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
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "local_provider_idx"
      ON "builder"."local_provider" ("tenant_id", "provider_id");
    INSERT INTO "builder"."local_provider"
      ("id","tenant_id","provider_id","label","base_url","models","selected_model","priority")
      VALUES ('lp_seed', 't_local', 'local', 'Ollama', 'http://localhost:11434/v1',
              '["llama3.2","qwen2.5"]', 'qwen2.5', 2);
  `);

  await prepareDatabase(host);

  const providerRows = await host.db.execute<{ id: string; name: string; base_url: string }>(
    sql`SELECT * FROM "public"."model_provider" WHERE "name" = 'local'`,
  );
  const providerRow = (providerRows.rows as { id: string; name: string; base_url: string }[])[0];
  check(
    "the pre-migration row lands as a model_provider, base URL carried across",
    providerRow?.base_url === "http://localhost:11434/v1",
    JSON.stringify(providerRow),
  );

  const credentialRows = await host.db.execute<{ metadata: unknown }>(
    sql`SELECT * FROM "public"."credential" WHERE "name" = 'provider:local'`,
  );
  const credentialRow = (credentialRows.rows as { metadata: { keyless?: boolean } }[])[0];
  check(
    "and a keyless placeholder credential, never a real secret",
    credentialRow?.metadata?.keyless === true,
    JSON.stringify(credentialRow?.metadata),
  );

  const providerVendorRows = await host.db.execute<{ metadata: { label?: string } }>(
    sql`SELECT * FROM "public"."provider" WHERE "name" = 'local'`,
  );
  const providerVendorRow = (providerVendorRows.rows as { metadata: { label?: string } }[])[0];
  check(
    "the label is carried across on the provider row",
    providerVendorRow?.metadata?.label === "Ollama",
    JSON.stringify(providerVendorRow?.metadata),
  );

  const offeringRows = await host.db.execute<{
    canonical_name: string;
    priority: number;
    disabled: boolean;
  }>(sql`
    SELECT m.canonical_name, mo.priority, mo.disabled
    FROM "public"."model_offering" mo
    JOIN "public"."model" m ON m.id = mo.model_id
    JOIN "public"."model_provider" mp ON mp.id = mo.provider_id
    WHERE mp.name = 'local'
    ORDER BY mo.priority
  `);
  const offerings = offeringRows.rows as { canonical_name: string; priority: number; disabled: boolean }[];
  check(
    "every probed model is carried across as an offering",
    offerings.length === 2 && offerings.every((row) => row.priority >= 2000 && row.priority < 3000),
    JSON.stringify(offerings),
  );
  check(
    "the previously selected model is carried across as the only enabled offering",
    offerings.filter((row) => !row.disabled).length === 1 &&
      offerings.find((row) => !row.disabled)?.canonical_name === "qwen2.5",
    JSON.stringify(offerings),
  );

  const tableRows = await host.db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'builder' AND table_name = 'local_provider'
  `);
  check("builder.local_provider is gone after the migration", tableRows.rows.length === 0);

  const derived = await host.db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'builder' AND table_name IN ('human_wait', 'stage_question')
  `);
  check(
    "human_wait and stage_question are gone: decisions and questions are derived",
    derived.rows.length === 0,
    derived.rows.map((row) => row.table_name).join(", "),
  );

  // Idempotent: re-running finds nothing left to migrate and does not choke
  // on the now-missing table.
  let rerunFailed = false;
  await prepareDatabase(host).catch(() => {
    rerunFailed = true;
  });
  check("running the migration again is a no-op, not a failure", !rerunFailed);

  await host.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nUpgrade smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
