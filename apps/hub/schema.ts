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

export const project = builder.table(
  "project",
  {
    id: id(),
    tenantId: text("tenant_id").notNull(),
    title: text("title").notNull(),
    /** Optimistic concurrency for existing-project mutations. */
    revision: integer("revision").notNull().default(1),
    activeBranchId: text("active_branch_id"),
    policy: jsonb("policy").notNull(),
    policyVersion: integer("policy_version").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("project_tenant_idx").on(table.tenantId, table.createdAt)],
);

export const participant = builder.table(
  "participant",
  {
    projectId: text("project_id").notNull(),
    principalId: text("principal_id").notNull(),
    /** One row per role held; authority checks read this set. */
    role: text("role").notNull(),
    audienceName: text("audience_name"),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.principalId, table.role] })],
);

export const branch = builder.table(
  "branch",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    /** Branches root at a selected stage-3 proposal version. Null for the root branch. */
    rootVersionId: text("root_version_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("branch_project_name_idx").on(table.projectId, table.name)],
);

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
    branchId: text("branch_id").notNull(),
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

export const approvalRecord = builder.table(
  "approval_record",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    runId: text("run_id").notNull(),
    stage: integer("stage").notNull(),
    command: text("command").notNull(),
    decision: text("decision").notNull(),
    actorPrincipalId: text("actor_principal_id").notNull(),
    authority: text("authority").notNull(),
    /** Set for stage-5 per-audience decisions; null for a transitioning approval. */
    audienceName: text("audience_name"),
    /** The exact versions reviewed, each with the hash the approver saw. */
    versions: jsonb("versions").notNull(),
    rationale: text("rationale"),
    assumptions: jsonb("assumptions"),
    policyVersion: integer("policy_version").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("approval_run_idx").on(table.runId, table.createdAt)],
);

export const decisionFlag = builder.table("decision_flag", {
  id: id(),
  projectId: text("project_id").notNull(),
  runId: text("run_id").notNull(),
  trigger: text("trigger").notNull(),
  classification: text("classification").notNull(),
  evidence: jsonb("evidence").notNull(),
  chosenRoute: integer("chosen_route"),
  rejectedRoutes: jsonb("rejected_routes"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
});

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
export const humanWait = builder.table(
  "human_wait",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    runId: text("run_id").notNull(),
    stage: integer("stage").notNull(),
    title: text("title").notNull(),
    consequence: text("consequence").notNull(),
    requiredAuthority: text("required_authority").notNull(),
    versions: jsonb("versions").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyError: text("notify_error"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("human_wait_open_idx").on(table.resolvedAt, table.createdAt)],
);

// `local_provider` is gone: a local endpoint (Ollama and compatible) is now
// registered through Interchange's own catalog rows — `provider`,
// `model_provider`, `model`, `model_offering` — via `hub-catalog.ts`'s
// `registerProviderCatalog`, using a placeholder `credential` row tagged
// `{ keyless: true }` in place of a real one. See CL-7573.

export const auditEvent = builder.table(
  "audit_event",
  {
    id: id(),
    projectId: text("project_id"),
    actorPrincipalId: text("actor_principal_id").notNull(),
    authority: text("authority"),
    command: text("command").notNull(),
    /** Ledger transition id, so an audit row names the rule it satisfied. */
    transitionId: text("transition_id"),
    correlationId: text("correlation_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    outcome: text("outcome").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("audit_project_idx").on(table.projectId, table.createdAt)],
);

/** Transactional outbox. Committed with the state change it describes. */
export const outboxEntry = builder.table(
  "outbox_entry",
  {
    id: id(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    correlationId: text("correlation_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (table) => [index("outbox_pending_idx").on(table.deliveredAt, table.createdAt)],
);

/** Command dedupe. A replayed envelope returns the first result, never a second effect. */
export const commandReceipt = builder.table("command_receipt", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  commandType: text("command_type").notNull(),
  result: jsonb("result").notNull(),
  createdAt: createdAt(),
});

export const hostPreference = builder.table("host_preference", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The questions a specialist left in a draft, asked one at a time.
 *
 * A draft that ends with six questions has not asked six questions — it has
 * printed them. They are held here in order and spoken one per turn, so the
 * person answers a conversation instead of filling in a form, and so an
 * unanswered question is a fact the product can see rather than prose someone
 * may have scrolled past.
 *
 * This is the one piece of the old stage-conversation store that survives the
 * cutover to Interchange's native `agent_session` / `session_mail`: the
 * platform has no notion of "ask one question at a time out of a batch", so
 * that remains genuine Builder product logic, kept as the smallest table that
 * can hold it. Everything else — the turns themselves, and their compaction —
 * moved to `hub-conversation.ts`.
 */
export const stageQuestion = builder.table(
  "stage_question",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    branchId: text("branch_id").notNull(),
    stage: integer("stage").notNull(),
    runId: text("run_id").notNull(),
    /** The version that asked it. Questions do not outlive their draft. */
    sourceNodeId: text("source_node_id").notNull(),
    /** Order within that draft. */
    ordinal: integer("ordinal").notNull(),
    body: text("body").notNull(),
    /** The `session_mail` id of the human turn that answered it, once one has. */
    answerMessageId: text("answer_message_id"),
    /** Set when a later draft supersedes the version that asked. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("stage_question_thread_idx").on(table.projectId, table.branchId, table.stage)],
);

/**
 * What an agent invocation was, and what it produced — BUILD_PLAN_V3 §8.
 *
 * §8: "Every invocation carries tenant/project/branch/stage, source versions,
 * decisions/policy, correlation/idempotency; output is a validated draft with
 * citations, assumptions/uncertainty, questions, recommended route and run
 * record."
 *
 * Provenance on the artifact says which model wrote it. This says which
 * *prompt version* and which *binding* wrote it, what it filled in for itself,
 * and what it still wanted to know — the things you need to judge a draft
 * after the fact, and the things a re-run has to reproduce.
 */
export const agentRunRecord = builder.table(
  "agent_run_record",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    branchId: text("branch_id").notNull(),
    runId: text("run_id").notNull(),
    stage: integer("stage").notNull(),
    agentId: text("agent_id").notNull(),
    /** The seed keys, so a draft names the exact records it came from. */
    promptKey: text("prompt_key").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    modelKey: text("model_key").notNull(),
    /** What actually served it, which is not the same as what was asked for. */
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    /** Exact approved versions the invocation was given. */
    inputVersionIds: jsonb("input_version_ids").notNull(),
    producedNodeId: text("produced_node_id"),
    /** Stated by the agent, lifted from the draft's own headings. */
    assumptions: jsonb("assumptions").notNull(),
    questions: jsonb("questions").notNull(),
    outcome: text("outcome").notNull(),
    failure: text("failure"),
    createdAt: createdAt(),
  },
  (table) => [index("agent_run_record_project_idx").on(table.projectId, table.stage)],
);
