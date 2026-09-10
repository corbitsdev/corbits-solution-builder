/**
 * Workflow definitions, written through Interchange's own table.
 *
 * The rows live in the platform's schema, so the reach into `@intx/db` belongs
 * here rather than in the app package, which builds the definitions and
 * knows nothing about where they land.
 */
import { and, desc, eq, type Column } from "drizzle-orm";
import { hub } from "./hub-mount.js";

export type DefinitionRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly wireHash: string;
  readonly grantRequirements?: readonly unknown[];
};

type Handle = {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<{ id: string; wireHash: string | null }[]>;
    };
  };
  insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> };
};

/**
 * Creates the definition unless a row with the same name already carries this
 * wire hash. Returns whether it wrote one, which is what makes seeding
 * idempotent: an unchanged definition is a no-op and a changed one is a new
 * version, leaving running instances on the version they started with.
 */
export async function putWorkflowDefinition(
  tenantId: string,
  row: DefinitionRow,
): Promise<{ id: string; created: boolean }> {
  const { workflowDefinition } = await import("@intx/db/schema");
  const db = hub().db.db as unknown as Handle;

  // The vendored schema is declared opaquely in `types/intx.d.ts` — the vendor
  // is typechecked upstream, not here — so the columns are named explicitly.
  const columns = workflowDefinition as unknown as { tenantId: Column; name: Column };

  const existing = await db
    .select()
    .from(workflowDefinition)
    .where(and(eq(columns.tenantId, tenantId), eq(columns.name, row.name)));

  const current = existing.find((entry) => entry.wireHash === row.wireHash);
  if (current) return { id: current.id, created: false };

  await db.insert(workflowDefinition).values({
    id: row.id,
    tenantId,
    name: row.name,
    description: row.description,
    wireHash: row.wireHash,
    // Resolved at launch into materialized grants, against the authority of
    // whoever started the run.
    ...(row.grantRequirements && row.grantRequirements.length > 0
      ? { grantRequirements: row.grantRequirements }
      : {}),
  });
  return { id: row.id, created: true };
}

type SelectHandle = {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => {
        orderBy: (order: unknown) => Promise<{ id: string }[]>;
      };
    };
  };
};

/**
 * The id of the current definition for a name, or `null` if it has not been
 * seeded yet. "Current" is the most recently created row: seeding never
 * mutates a definition, it only adds a new version, so the newest row by
 * `createdAt` is the one a fresh session should be keyed to.
 */
export async function getWorkflowDefinitionId(
  tenantId: string,
  name: string,
): Promise<string | null> {
  const { workflowDefinition } = await import("@intx/db/schema");
  const db = hub().db.db as unknown as SelectHandle;
  const columns = workflowDefinition as unknown as {
    tenantId: Column;
    name: Column;
    createdAt: Column;
  };

  const rows = await db
    .select()
    .from(workflowDefinition)
    .where(and(eq(columns.tenantId, tenantId), eq(columns.name, name)))
    .orderBy(desc(columns.createdAt));

  return rows[0]?.id ?? null;
}
