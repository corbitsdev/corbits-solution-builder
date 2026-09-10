/**
 * Builder-owned persistence — BUILD_PLAN_V3 sections 6 and 11.
 *
 * Everything Builder owns lives in the `builder` schema. Artifact bytes and
 * their versions live in the adopted `@corbits/artifacts` tables under the
 * `artifacts` schema; this schema carries the layer that package does not
 * provide — cross-artifact lineage edges, approvals, provenance and retention.
 *
 * Two rules the column set enforces rather than documents:
 *   - approvals name an exact version *and* its content hash, so an approval
 *     can never be read as covering a newer draft;
 *   - state changes, audit rows and outbox rows commit in one transaction.
 */
import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const BUILDER_SCHEMA = "builder";
const builder = pgSchema(BUILDER_SCHEMA);

const id = () => text("id").primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * There is no `run` table. A project's run record folds from the ledger
 * thread (`runs.ts`); where it stands in the runtime is the hub's own
 * workflow run on the project's deployment (`hub-executor.ts`).
 */

/**
 * Builder's artifact-graph layer over `@corbits/artifacts`. `artifactId` and
 * `version` address the adopted package's row; everything else is the lineage,
 * provenance and approval surface it does not model.
 */
export const artifactNode = builder.table(
  "artifact_node",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    version: integer("version").notNull(),
    kind: text("kind").notNull(),
    /** Null except where one kind has parallel artifacts, as at stage 5. */
    variant: text("variant"),
    stage: integer("stage").notNull(),
    title: text("title").notNull(),
    mediaType: text("media_type").notNull(),
    /** SHA-256 of the exact bytes. Approvals compare against this, not the id. */
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Opaque sink reference. A local reference never implies remote access. */
    sink: text("sink").notNull().default("local"),
    producerRunId: text("producer_run_id"),
    provenance: jsonb("provenance").notNull(),
    supersededByNodeId: text("superseded_by_node_id"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("artifact_node_version_idx").on(table.artifactId, table.version),
    index("artifact_node_project_stage_idx").on(table.projectId, table.stage),
  ],
);

/** Explicit source edges. Empty for a graph root; never inferred from time order. */
export const artifactEdge = builder.table(
  "artifact_edge",
  {
    childNodeId: text("child_node_id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.childNodeId, table.sourceNodeId] })],
);

/**
 * A durable human wait. Committed *before* the notification is sent, so a
 * failed notification loses a ping and never a decision request.
 */
// `local_provider` is gone: a local endpoint (Ollama and compatible) is now
// registered through Interchange's own catalog rows — `provider`,
// `model_provider`, `model`, `model_offering` — via `hub-catalog.ts`'s
// `registerProviderCatalog`, using a placeholder `credential` row tagged
// `{ keyless: true }` in place of a real one. See CL-7573.

