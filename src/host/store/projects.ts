/**
 * Project and artifact-graph writes.
 *
 * `project.create` is separate from the command engine because it is the one
 * command with no source run to guard — the ledger's only `from: null` row.
 * Artifact writes are here too: they are how a stage produces something, and
 * they never transition anything.
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { createArtifact, writeArtifactVersion } from "@corbits/artifacts";
import { database } from "../db/client.js";
import { withPostgresJsResultShape } from "../db/pg-compat.js";
import * as table from "../db/schema.js";
import { newId, sha256 } from "../ids.js";
import { HostError, notFound } from "../errors.js";
import { origin } from "../guard.js";
import { ARTIFACT_STAGE, type ArtifactDraft } from "../../contracts/domain.js";
import type { ProjectPolicy } from "../engine.js";
import { launchProjectRun, rehydrateRun, soloApprovalFor } from "../engine.js";
import type { Stage } from "../../contracts/ledger.js";
import { nextQuestion } from "./questions.js";
import { liveDraft } from "./live-drafts.js";
import { activityHeadline } from "../../contracts/next-step.js";
import {
  activeRunRecord,
  projectExecutionStatus,
  putRunRecord,
  runRecordsForProject,
} from "../hub/executor.js";

export const LOCAL_TENANT = "t_local";

/**
 * The workspace tenant and its owner principal.
 *
 * These rows belong to the Interchange control plane, so they are written only
 * when the hub is embedded and shares this database. A hosted hub owns its own
 * tenants and principals, and they arrive through its API instead.
 */
export async function ensureWorkspace(owner: {
  principalId: string;
  displayName: string;
}): Promise<void> {
  const { hubMode } = await import("../hub/endpoint.js");
  if (hubMode() !== "embedded") return;

  const { db } = database();
  await db.execute(
    // Idempotent: setup, restart and upgrade all call this, and none of them
    // may overwrite a choice the user already made.
    // prettier-ignore
    // Interchange's tenant table: `slug` and `domain` are NOT NULL and unique.
    // The domain is a reserved-TLD placeholder because a local workspace has no
    // real one and inventing a routable domain would be worse than admitting it.
    (await import("drizzle-orm")).sql`
      INSERT INTO "public"."tenant" ("id","name","slug","domain")
      VALUES (${LOCAL_TENANT}, 'Local workspace', 'local', 'local.solutions-builder.invalid')
      ON CONFLICT ("id") DO NOTHING
    `,
  );
  await db.execute(
    (await import("drizzle-orm")).sql`
      INSERT INTO "public"."principal" ("id","tenant_id","kind","ref_id","status")
      VALUES (${owner.principalId}, ${LOCAL_TENANT}, 'user', ${owner.principalId}, 'active')
      ON CONFLICT ("id") DO NOTHING
    `,
  );
}

export async function createProject(args: {
  title: string;
  policy: ProjectPolicy;
  owner: { principalId: string; displayName: string };
  problemStatement?: string;
}): Promise<{ projectId: string; branchId: string; runId: string }> {
  const { db } = database();

  // `project.create` is the one command with no state to leave, so `evaluate`
  // cannot judge it — but its ledger row still says what opening a project
  // means, and this reads that rather than restating it.
  const transition = origin("project.create");
  if (!transition) throw new HostError("internal_error", "No ledger row opens a project.");
  const stage = transition.stages?.[0] ?? 1;
  const opening = transition.to;
  if (!opening) throw new HostError("internal_error", "The opening transition names no state.");

  // The precondition the row names: "valid initial policy and workspace scope".
  if (args.title.trim().length === 0) {
    throw new HostError("validation_failed", "A project needs a title.");
  }
  if (args.policy.audienceQuorum < 0) {
    throw new HostError("validation_failed", "An audience quorum cannot be negative.");
  }

  await ensureWorkspace(args.owner);

  const created = await db.transaction(async (tx) => {
    const projectId = newId.project();
    const branchId = newId.branch();
    const runId = newId.run();

    await tx.insert(table.project).values({
      id: projectId,
      tenantId: LOCAL_TENANT,
      title: args.title,
      activeBranchId: branchId,
      policy: args.policy,
    });
    await tx.insert(table.branch).values({
      id: branchId,
      projectId,
      name: "main",
    });

    // The owner holds every authority a single-user local workspace needs.
    // Separate rows rather than one super-role, so an authority check reads the
    // same way here as it will when these are different people.
    const roles = [
      "project_owner",
      "budget_approver",
      "technical_approver",
      "builder_operator",
      "delivery_recipient",
      "audience_member",
    ] as const;
    for (const role of roles) {
      await tx.insert(table.participant).values({
        projectId,
        principalId: args.owner.principalId,
        role,
      });
    }

    await tx.insert(table.auditEvent).values({
      id: newId.audit(),
      projectId,
      actorPrincipalId: args.owner.principalId,
      authority: "project_owner",
      command: transition.command,
      transitionId: transition.id,
      correlationId: newId.correlation(),
      before: null,
      after: { projectId, runId, stage },
      outcome: "committed",
    });

    // The one run-opening write outside `engine.ts` — `project.create` has no
    // source run to guard, so it never reaches `execute()`. A plain in-memory
    // op, not a database write, so it is safe inside this transaction.
    putRunRecord({
      id: runId,
      projectId,
      branchId,
      kind: opening.kind,
      stage,
      state: opening.state,
      sourceRunId: null,
      originId: runId,
      terminalReason: null,
      costApprovalVersionId: null,
      routeTargetStage: null,
      packetId: null,
      checkpointRef: null,
      createdAt: new Date(),
      endedAt: null,
    });

    return { projectId, branchId, runId };
  });

  // Outside the transaction: the executor is not reachable from inside one
  // (it would deadlock against the same single-writer connection `tx` holds).
  await launchProjectRun({ projectId: created.projectId, branchId: created.branchId });

  return created;
}

/**
 * Writes an artifact version and its lineage edges.
 *
 * Bytes go to the adopted `@corbits/artifacts` store; the node row here carries
 * what that package does not model — stage, branch, exact-version hash, source
 * edges and provenance. A model drafts; this function is what makes it an
 * artifact.
 */
export async function writeArtifact(
  draft: ArtifactDraft,
  actor: { principalId: string },
): Promise<{ nodeId: string; artifactId: string; version: number; contentHash: string }> {
  const { db, artifactDb } = database();
  const stage = ARTIFACT_STAGE[draft.kind] as Stage;
  const contentHash = await sha256(draft.content);

  const scope = {
    tenantId: LOCAL_TENANT,
    principalId: actor.principalId,
    identity: { kind: "user" as const, principalId: actor.principalId },
  };

  // Revising an existing artifact of the same kind on the same branch adds a
  // version; a new kind starts a new artifact. Corrections create versions —
  // they never overwrite what an approval may already name.
  const [existing] = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, draft.projectId),
        eq(table.artifactNode.branchId, draft.branchId),
        eq(table.artifactNode.kind, draft.kind),
        // A revision replaces the same variant only; stage 5's audience
        // packages are siblings, not versions of one another.
        draft.variant === undefined
          ? isNull(table.artifactNode.variant)
          : eq(table.artifactNode.variant, draft.variant),
      ),
    )
    .orderBy(desc(table.artifactNode.version))
    .limit(1);

  const nodeId = newId.node();

  // The bytes and the lineage row commit together or not at all. Written as
  // two transactions, a failure between them left a committed artifact version
  // no graph node pointed at — invisible to every reader, and the next write
  // stacked version N+1 on a phantom N. `artifactDb` is the same handle as
  // `db`, so the artifact package's own transaction nests as a savepoint.
  const { artifactId, version } = await db.transaction(async (tx) => {
    const artifactTx = withPostgresJsResultShape(tx) as unknown as typeof artifactDb;

    let artifactId: string;
    let version: number;
    if (existing) {
      artifactId = existing.artifactId;
      const revised = await writeArtifactVersion(artifactTx, {
        scope,
        artifactId,
        title: draft.title,
        content: draft.content,
      });
      version = revised.version;
    } else {
      const row = await createArtifact(artifactTx as never, {
        scope,
        // The workspace owner owns everything a specialist drafts on their
        // behalf; provenance of *who produced it* lives on the graph node.
        ownerPrincipalId: actor.principalId,
        kind: "document",
        title: draft.title,
        content: draft.content,
        source: { origin: draft.provenance.producer === "agent" ? "agent" : "manual" },
      });
      artifactId = row.id;
      version = row.version;
    }

    await tx.insert(table.artifactNode).values({
      id: nodeId,
      projectId: draft.projectId,
      branchId: draft.branchId,
      artifactId,
      version,
      kind: draft.kind,
      variant: draft.variant ?? null,
      stage,
      title: draft.title,
      mediaType: draft.mediaType,
      contentHash,
      sizeBytes: new TextEncoder().encode(draft.content).length,
      producerRunId: draft.provenance.runId ?? null,
      provenance: draft.provenance,
    });
    for (const sourceId of draft.sourceVersionIds) {
      await tx.insert(table.artifactEdge).values({ childNodeId: nodeId, sourceNodeId: sourceId });
    }
    if (existing) {
      await tx
        .update(table.artifactNode)
        .set({ supersededByNodeId: nodeId })
        .where(eq(table.artifactNode.id, existing.id));
    }
    return { artifactId, version };
  });

  return { nodeId, artifactId, version, contentHash };
}

/**
 * Renames a project.
 *
 * A project is opened with the first line of what somebody typed, because it
 * has to open whether or not a model is reachable. The real name arrives a
 * moment later, from a specialist that read the whole problem.
 */
export async function renameProject(projectId: string, title: string): Promise<void> {
  const { db } = database();
  await db
    .update(table.project)
    .set({ title, revision: sql`${table.project.revision} + 1` })
    .where(eq(table.project.id, projectId));
}

/** Archived projects stay listed, folded away; nothing about them is lost. */
export async function archiveProject(projectId: string, archived: boolean): Promise<void> {
  const { db } = database();
  await db
    .update(table.project)
    .set({ archivedAt: archived ? new Date() : null, revision: sql`${table.project.revision} + 1` })
    .where(eq(table.project.id, projectId));
}

/**
 * A soft delete: the row is hidden from every listing, and its artifacts and
 * approvals stay on disk. Dropping someone's work is not a thing a UI button
 * should be able to do irreversibly.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const { db } = database();
  await db
    .update(table.project)
    .set({ deletedAt: new Date(), revision: sql`${table.project.revision} + 1` })
    .where(eq(table.project.id, projectId));
}

export async function readArtifactNode(nodeId: string) {
  const { db, artifactDb } = database();
  const [node] = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.id, nodeId));
  if (!node) throw notFound("That artifact version");
  const { getArtifactVersion } = await import("@corbits/artifacts");
  const stored = await getArtifactVersion(artifactDb, node.artifactId, node.version);
  return { node, content: stored?.content ?? "" };
}

export async function listProjects() {
  const { db } = database();
  const projects = await db
    .select()
    .from(table.project)
    .where(isNull(table.project.deletedAt))
    .orderBy(desc(table.project.createdAt));

  return Promise.all(
    projects.map(async (row) => {
      const current = activeRunRecord(row.id) ?? (await rehydrateRun(row.id)) ?? null;
      const waits = await db
        .select()
        .from(table.humanWait)
        .where(
          and(eq(table.humanWait.projectId, row.id), isNull(table.humanWait.resolvedAt)),
        );
      // Whose move it is on the current stage. "In progress" alone cannot tell
      // a list apart: the model writing, a question waiting on the person and
      // a draft waiting to be approved are all "in progress".
      const stage = current?.stage ?? null;
      const branchId = row.activeBranchId ?? "";
      const [drafts, open] = stage
        ? await Promise.all([
            db
              .select({ id: table.artifactNode.id })
              .from(table.artifactNode)
              .where(
                and(
                  eq(table.artifactNode.projectId, row.id),
                  eq(table.artifactNode.stage, stage),
                  isNull(table.artifactNode.supersededByNodeId),
                ),
              )
              .limit(1),
            nextQuestion(row.id, branchId, stage),
          ])
        : [[], null];
      const turn: "writing" | "question" | "approve" | "idle" =
        stage && liveDraft(row.id, stage) !== null
          ? "writing"
          : open
            ? "question"
            : drafts.length > 0
              ? "approve"
              : "idle";
      return {
        id: row.id,
        title: row.title,
        archivedAt: row.archivedAt,
        stage,
        state: current?.state ?? null,
        turn,
        ...(open ? { question: { ordinal: open.ordinal, remaining: open.remaining } } : {}),
        runId: current?.id ?? null,
        branchId: row.activeBranchId,
        policy: row.policy,
        needsDecision: waits.length > 0,
        waits,
      };
    }),
  );
}

export async function projectDetail(projectId: string, actorPrincipalId: string) {
  const { db } = database();
  const [row] = await db
    .select()
    .from(table.project)
    .where(and(eq(table.project.id, projectId), isNull(table.project.deletedAt)));
  if (!row) throw notFound("That project");

  const runs = runRecordsForProject(projectId);
  const nodes = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId))
    .orderBy(asc(table.artifactNode.createdAt));
  const approvals = await db
    .select()
    .from(table.approvalRecord)
    .where(eq(table.approvalRecord.projectId, projectId))
    .orderBy(asc(table.approvalRecord.createdAt));
  const waits = await db
    .select()
    .from(table.humanWait)
    .where(and(eq(table.humanWait.projectId, projectId), isNull(table.humanWait.resolvedAt)));
  const flags = await db
    .select()
    .from(table.decisionFlag)
    .where(eq(table.decisionFlag.projectId, projectId))
    .orderBy(desc(table.decisionFlag.createdAt));
  const questions = await db
    .select()
    .from(table.buildQuestion)
    .where(eq(table.buildQuestion.projectId, projectId))
    .orderBy(asc(table.buildQuestion.createdAt));
  const manifests = await db
    .select()
    .from(table.deliveryManifest)
    .where(eq(table.deliveryManifest.projectId, projectId));

  // Run state lives in the runtime, in memory, so a restart leaves a project
  // that exists with nothing open on it. Recovering the position from the
  // artifacts and decisions that are durable beats showing somebody a project
  // they can see and cannot open.
  const current =
    runs.filter((run) => run.endedAt === null).at(-1) ??
    runs.at(-1) ??
    (await rehydrateRun(projectId)) ??
    null;

  // "What is happening right now", not just the state enum: the runtime
  // executor is asked where its own run for this stage actually is, and that
  // — plus whether a draft already exists — is what turns "in_progress" into
  // "Drafting" or "Revising the draft" instead of leaving the machine's own
  // vocabulary on the screen.
  let activity: { headline: string; stepId: string | null; parked: boolean; signalName: string | null } | null =
    null;
  let soloApproval = false;
  if (current) {
    const status = await projectExecutionStatus(projectId);
    const hasDraft = nodes.some((node) => node.stage === current.stage);
    const quorum =
      current.stage === 5
        ? {
            recorded: approvals.filter((approval) => approval.command === "audience.decide").length,
            needed: (row.policy as { audienceQuorum?: number }).audienceQuorum ?? 0,
            blocked: approvals.filter(
              (approval) => approval.command === "audience.decide" && approval.decision !== "proceed",
            ).length,
          }
        : undefined;
    activity = {
      headline: activityHeadline({
        state: current.state,
        stage: current.stage,
        parked: status?.parked ?? false,
        hasDraft,
        ...(quorum ? { quorum } : {}),
      }),
      stepId: status?.stepId ?? null,
      parked: status?.parked ?? false,
      signalName: status?.signalName ?? null,
    };
    soloApproval = await soloApprovalFor(projectId, current.stage, actorPrincipalId);
  }

  return {
    project: row,
    // History entries carry no `activity` — it is only ever computed for the
    // currently active run, never for one long past — but the shape stays
    // uniform so a caller can treat every entry in this array the same way.
    runs: runs.map((entry) => ({ ...entry, activity: null })),
    current: current ? { ...current, activity } : null,
    soloApproval,
    nodes,
    approvals,
    waits,
    flags,
    questions,
    manifests,
  };
}

/**
 * The artifact graph: every version, its explicit source edges, and what
 * superseded it. Retained history is the point — a superseded version is still
 * a node, and a rejected branch is still reachable.
 */
export async function artifactGraph(projectId: string) {
  const { db } = database();
  const nodes = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId))
    .orderBy(asc(table.artifactNode.stage), asc(table.artifactNode.createdAt));
  if (nodes.length === 0) return { nodes, edges: [] };

  const ids = new Set(nodes.map((node) => node.id));
  const allEdges = await db.select().from(table.artifactEdge);
  const edges = allEdges.filter(
    (edge) => ids.has(edge.childNodeId) && ids.has(edge.sourceNodeId),
  );
  return { nodes, edges };
}

export async function openDecisions() {
  const { db } = database();
  const waits = await db
    .select()
    .from(table.humanWait)
    .where(isNull(table.humanWait.resolvedAt))
    .orderBy(asc(table.humanWait.createdAt));
  if (waits.length === 0) return [];
  const projects = await db.select().from(table.project);
  const byId = new Map(projects.map((row) => [row.id, row]));
  return waits.map((wait) => ({
    ...wait,
    projectTitle: byId.get(wait.projectId)?.title ?? "Unknown project",
  }));
}
