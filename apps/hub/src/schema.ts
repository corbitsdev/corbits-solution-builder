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
 * There is no `run` table. A project's stage and state are read from the
 * runtime executor (`hub-executor.ts`), which is now the sole
 * authority for where a project is — see that module's `StoredRun` for the
 * record that used to live here, kept in-memory instead of in Postgres.
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

export const buildPacket = builder.table("build_packet", {
  id: id(),
  projectId: text("project_id").notNull(),
  sourceRunId: text("source_run_id").notNull(),
  /** Immutable once written. A second freeze for the same source is refused. */
  versions: jsonb("versions").notNull(),
  costApproval: jsonb("cost_approval").notNull(),
  placement: text("placement").notNull(),
  targets: jsonb("targets").notNull(),
  packetHash: text("packet_hash").notNull(),
  createdAt: createdAt(),
});

export const buildQuestion = builder.table(
  "build_question",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    runId: text("run_id").notNull(),
    /** The attempt that raised it; build.answer resumes exactly this origin. */
    originId: text("origin_id").notNull(),
    kind: text("kind").notNull(),
    prompt: text("prompt").notNull(),
    scopeImpact: jsonb("scope_impact"),
    deadline: timestamp("deadline", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answer: text("answer"),
    answeredBy: text("answered_by"),
    grantedCapabilities: jsonb("granted_capabilities"),
    createdAt: createdAt(),
  },
  (table) => [index("build_question_run_idx").on(table.runId, table.answeredAt)],
);

/** Typed worker progress. Events are never approvals and never carry bytes. */
export const buildEvent = builder.table(
  "build_event",
  {
    id: id(),
    runId: text("run_id").notNull(),
    /** Dedupe key; at-least-once delivery is assumed. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Monotonic per-run cursor so gaps are detectable, not merely unlikely. */
    cursor: integer("cursor").notNull(),
    type: text("type").notNull(),
    severity: text("severity").notNull().default("info"),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("build_event_dedupe_idx").on(table.runId, table.idempotencyKey),
    index("build_event_cursor_idx").on(table.runId, table.cursor),
  ],
);

export const deliveryManifest = builder.table("delivery_manifest", {
  id: id(),
  projectId: text("project_id").notNull(),
  buildRunId: text("build_run_id").notNull(),
  descriptors: jsonb("descriptors").notNull(),
  verification: jsonb("verification").notNull(),
  actualCost: jsonb("actual_cost"),
  exceptions: jsonb("exceptions"),
  manifestHash: text("manifest_hash").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: text("accepted_by"),
  createdAt: createdAt(),
});

/**
 * A durable human wait. Committed *before* the notification is sent, so a
 * failed notification loses a ping and never a decision request.
 */
// `local_provider` is gone: a local endpoint (Ollama and compatible) is now
// registered through Interchange's own catalog rows — `provider`,
// `model_provider`, `model`, `model_offering` — via `hub-catalog.ts`'s
// `registerProviderCatalog`, using a placeholder `credential` row tagged
// `{ keyless: true }` in place of a real one. See CL-7573.

