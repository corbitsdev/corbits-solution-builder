/**
 * Embed-hub-owned bearer tokens that let a deployed stage specialist's
 * `@corbits/artifacts` sidecar-bundle authenticate to the run-scoped
 * `mountWorkflowArtifacts` mount (see `index.ts`).
 *
 * `@corbits/artifacts` takes no position on how a host authenticates a run --
 * `mountWorkflowArtifacts` just calls back into `resolveRunScope(token,
 * address)`. Its OWN credential delivery pipeline (`credentialBindings` +
 * `provider`/`credential` rows, see vendor/interchange's
 * `resolveInferenceMaterials` family) only ever resolves a STATIC
 * tenant-owned secret -- there is no live path from a running sidecar's own
 * control-channel token into that pipeline at this pin, and threading the
 * sidecar's ambient session token into a tool-visible credential is exactly
 * what CL-8719 forbids. So the installer mints a fresh, purpose-built bearer
 * per specialist deployment at deploy time (`specialist-deploy.ts`), stores
 * it as an ordinary tenant credential behind the built-in `http` provider
 * (which injects it as `Authorization: Bearer <secret>`, pinned to the hub's
 * own origin), and this table is the one thing on the hub side that
 * remembers which anchor run that bearer is allowed to act for.
 *
 * The table holds only a SHA-256 digest of the token, never the token
 * itself -- the same posture `sidecar.tokenHashSha256` takes for the native
 * sidecar's own control-channel bearer.
 */
import { sql } from "drizzle-orm";
import type { AnyPgDatabase } from "@intx/db";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

/** Idempotent, called on every hub boot -- mirrors how `runArtifactMigrations`
 * and `runMailboxMigrations` are called in `index.ts`. This table has no
 * migration history yet, so a single `IF NOT EXISTS` is the whole story. */
export async function ensureWorkflowArtifactTokensTable(db: AnyPgDatabase): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "workflow_artifact_token" (
      "token_hash_sha256" text PRIMARY KEY,
      "tenant_id" text NOT NULL,
      "anchor_run_id" text NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
}

/** Called by the installer's deploy path once per specialist deployment. */
export async function registerWorkflowArtifactToken(
  db: AnyPgDatabase,
  input: { readonly token: string; readonly tenantId: string; readonly anchorRunId: string },
): Promise<void> {
  const tokenHash = await sha256Hex(input.token);
  await db.execute(sql`
    INSERT INTO "workflow_artifact_token" ("token_hash_sha256", "tenant_id", "anchor_run_id")
    VALUES (${tokenHash}, ${input.tenantId}, ${input.anchorRunId})
    ON CONFLICT ("token_hash_sha256")
    DO UPDATE SET "tenant_id" = EXCLUDED."tenant_id", "anchor_run_id" = EXCLUDED."anchor_run_id"
  `);
}

export type WorkflowArtifactTokenRow = { readonly tenantId: string; readonly anchorRunId: string };

export type WorkflowArtifactRunRow = {
  readonly id: string;
  readonly tenantId: string;
  /** Self for an anchor run, the anchor's id for a child run, null for a run
   * that predates the fold (never reachable here since our tokens only ever
   * name a deployment's own anchor). */
  readonly anchorRunId: string | null;
  readonly principalId: string | null;
};

export type ResolvedWorkflowArtifactRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

/**
 * Pure decision logic, independent of how the rows were looked up --
 * unit-tested directly, no database involved.
 *
 * `run` is the `workflow_run` addressed by the tool's `x-workflow-run-address`
 * header; it must belong to the token's tenant AND be the token's anchor run
 * or a descendant of it (a loop-iteration/child run's `anchor_run_id` FK
 * points at the anchor -- see `workflow_run.anchorRunId` in
 * vendor/interchange's schema). A child run carries no principal of its own
 * (it inherits the deployment's grants at read time), so `anchorPrincipalId`
 * is the fallback the deployment's own anchor row supplies.
 */
export function decideWorkflowArtifactRunScope(
  token: WorkflowArtifactTokenRow | null,
  run: WorkflowArtifactRunRow | null,
  anchorPrincipalId: string | null,
): ResolvedWorkflowArtifactRunScope | null {
  if (token === null || run === null) return null;
  if (run.tenantId !== token.tenantId) return null;
  const underAnchor = run.id === token.anchorRunId || run.anchorRunId === token.anchorRunId;
  if (!underAnchor) return null;
  const principalId = run.principalId ?? anchorPrincipalId;
  if (principalId === null) return null;
  return { tenantId: run.tenantId, principalId, runId: run.id };
}

export function createWorkflowArtifactRunResolver(db: AnyPgDatabase) {
  return async function resolveRunScope(
    bearerToken: string,
    runAddress: string,
  ): Promise<ResolvedWorkflowArtifactRunScope | null> {
    if (bearerToken === "" || runAddress === "") return null;
    const tokenHash = await sha256Hex(bearerToken);
    const tokenRows = (await db.execute(sql`
      SELECT "tenant_id" AS "tenantId", "anchor_run_id" AS "anchorRunId"
      FROM "workflow_artifact_token"
      WHERE "token_hash_sha256" = ${tokenHash}
    `)) as unknown as WorkflowArtifactTokenRow[];
    const token = tokenRows[0] ?? null;
    if (token === null) return null;

    const runRows = (await db.execute(sql`
      SELECT "id", "tenant_id" AS "tenantId", "anchor_run_id" AS "anchorRunId", "principal_id" AS "principalId"
      FROM "workflow_run"
      WHERE "address" = ${runAddress}
    `)) as unknown as WorkflowArtifactRunRow[];
    const run = runRows[0] ?? null;

    const anchorRows = (await db.execute(sql`
      SELECT "principal_id" AS "principalId" FROM "workflow_run" WHERE "id" = ${token.anchorRunId}
    `)) as unknown as { principalId: string | null }[];
    const anchorPrincipalId = anchorRows[0]?.principalId ?? null;

    return decideWorkflowArtifactRunScope(token, run, anchorPrincipalId);
  };
}
