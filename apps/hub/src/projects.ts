/**
 * Project and artifact-graph writes.
 *
 * `project.create` is separate from the command engine because it is the one
 * command with no source run to guard — the ledger's only `from: null` row.
 * Artifact writes are here too: they are how a stage produces something, and
 * they never transition anything.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { database } from "./db.js";
import * as table from "./schema.js";
import { newId, sha256 } from "./ids.js";
import { HostError, notFound } from "./errors.js";
import { origin } from "@solutions-builder/app/guard";
import { ARTIFACT_STAGE, type ArtifactDraft } from "./domain.js";
import { packageOutlineProblem } from "@solutions-builder/app/deck";
import { soloApprovalFor } from "./command-dispatch.js";
import { allCarriedTurns, ledgerCommands, recordCommand } from "./command-ledger.js";
import type { Stage } from "@solutions-builder/app/ledger";
import { projectApprovals, projectFlags, projectQuestions } from "@solutions-builder/app/project-state";
import { foldedRunsFor, openDecisionFor } from "./decisions.js";
import { currentAnchor } from "./lifecycle-run.js";
import { activeRun, runsForProject } from "./runs.js";
import { artifacts, tenantId } from "./hub-client.js";
import { listProjectRecords, requireProject } from "./project-records.js";

/**
 * The ledger half of opening a project: `project.create` and the first run.
 * The tenant, authority and credential delegation are the installer's
 * `createProject`; this is the host-only write that follows.
 */
export async function openProject(args: {
  projectId: string;
  owner: { principalId: string; displayName: string };
  problemStatement?: string;
}): Promise<{ projectId: string; runId: string }> {
  await requireProject(args.projectId);
  const already = await existingOpening(args.projectId);
  if (already) return already;

  // `project.create` is the one command with no state to leave, so `evaluate`
  // cannot judge it — but its ledger row still says what opening a project
  // means, and this reads that rather than restating it.
  const transition = origin("project.create");
  if (!transition) throw new HostError("internal_error", "No ledger row opens a project.");
  const stage = transition.stages?.[0] ?? 1;
  const opening = transition.to;
  if (!opening) throw new HostError("internal_error", "The opening transition names no state.");

  const runId = newId.run();

  await recordCommand({
    projectId: args.projectId,
    actorPrincipalId: args.owner.principalId,
    authority: "project_owner",
    command: transition.command,
    transitionId: transition.id,
    correlationId: newId.correlation(),
    before: null,
    after: { projectId: args.projectId, runId, stage, state: opening.state },
    idempotencyKey: newId.command(),
    result: {
      runId,
      stage,
      state: opening.state,
      transitionId: transition.id,
      replayed: false,
    },
    stage,
    runId,
    ...(args.problemStatement?.trim() ? { message: args.problemStatement.trim() } : {}),
  });
  // The client fires the deployment's run right after this: `createProject`
  // in `apps/web/src/client.ts`, via `@intx/hub-client`'s `triggerWorkflowRun`.
  return { projectId: args.projectId, runId };
}

async function existingOpening(projectId: string): Promise<{ projectId: string; runId: string } | null> {
  const opening = (await ledgerCommands(projectId)).find((command) => command.command === "project.create");
  if (!opening) return null;
  const after = opening.after as { runId?: string } | undefined;
  if (typeof after?.runId === "string") return { projectId, runId: after.runId };
  throw new HostError("conflict", "That project is already open.");
}

/**
 * Writes an artifact version and its lineage edges.
 *
 * Bytes go to the mounted `@corbits/artifacts` module, over its own HTTP
 * routes; the node row here carries what that module does not model — stage,
 * branch, exact-version hash, source edges and provenance. A model drafts;
 * this function is what makes it an artifact.
 *
 * The artifact write and the node insert are no longer one database
 * transaction: the module is reached over HTTP (in-process today, a separate
 * service once a hub is hosted), so a failure between the two now leaves a
 * committed artifact version with no graph node pointing at it, recoverable
 * by content hash rather than guaranteed unreachable by construction. That
 * tradeoff is the cost of the module owning its own storage.
 */
export async function writeArtifact(
  draft: ArtifactDraft,
  actor: { principalId: string },
): Promise<{ nodeId: string; artifactId: string; version: number; contentHash: string }> {
  const { db } = database();
  const stage = ARTIFACT_STAGE[draft.kind] as Stage;
  // A stakeholder's package is where their slides come from, so a package
  // without a deck outline is not a package, whoever wrote it: the
  // presentation creator, a person, an import. Refused before it is a version.
  if (draft.kind === "audience_package") {
    const problem = packageOutlineProblem(draft.content);
    if (problem) {
      throw new HostError(
        "validation_failed",
        `The package${draft.variant ? ` for ${draft.variant}` : ""} was not recorded: ${problem}.`,
        { kind: draft.kind, ...(draft.variant ? { variant: draft.variant } : {}) },
        false,
      );
    }
  }
  const contentHash = await sha256(draft.content);

  // Revising an existing artifact of the same kind on the same branch adds a
  // version; a new kind starts a new artifact. Corrections create versions —
  // they never overwrite what an approval may already name.
  const [existing] = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, draft.projectId),
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

  let artifactId: string;
  let version: number;
  if (existing) {
    artifactId = existing.artifactId;
    const revised = await artifacts.revise(artifactId, {
      title: draft.title,
      content: draft.content,
    });
    version = revised.version;
  } else {
    const row = await artifacts.create({ title: draft.title, content: draft.content });
    artifactId = row.id;
    version = row.version;
  }

  await db.transaction(async (tx) => {
    await tx.insert(table.artifactNode).values({
      id: nodeId,
      projectId: draft.projectId,

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
  });

  return { nodeId, artifactId, version, contentHash };
}

/**
 * A node's content, over the mounted module's routes. Only its CURRENT
 * version is fetchable that way (see `exportArtifactNodes`'s note) — a
 * superseded node's exact historical bytes are no longer reachable, so this
 * answers with whatever the artifact holds now.
 */
export async function readArtifactNode(nodeId: string) {
  const { db } = database();
  const [node] = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.id, nodeId));
  if (!node) throw notFound("That artifact version");
  const stored = await artifacts.get(node.artifactId);
  return { node, content: stored?.content ?? "" };
}

export async function listProjects() {
  const { db } = database();
  const projects = await listProjectRecords();
  const workspaceTenantId = tenantId();

  return Promise.all(
    projects.map(async (row) => {
      const current = await activeRun(row.id);
      const decision = await openDecisionFor(row.id);
      const waits = decision ? [decision] : [];
      // Whose move it is on the current stage. "In progress" alone cannot tell
      // a list apart: a draft waiting to be approved is not the same as an
      // open interview question — but the question case is a fold of `/hub`
      // events, so it is left to the client (`tenantId`/`anchorRunId` below);
      // this only says whether there is a draft to approve.
      const stage = current?.stage ?? null;
      const drafts = stage
        ? await db
            .select({ id: table.artifactNode.id })
            .from(table.artifactNode)
            .where(
              and(
                eq(table.artifactNode.projectId, row.id),
                eq(table.artifactNode.stage, stage),
                isNull(table.artifactNode.supersededByNodeId),
              ),
            )
            .limit(1)
        : [];
      const turn: "writing" | "question" | "approve" | "idle" = drafts.length > 0 ? "approve" : "idle";
      return {
        id: row.id,
        title: row.title,
        archivedAt: row.archivedAt,
        stage,
        state: current?.state ?? null,
        turn,
        runId: current?.id ?? null,
        policy: row.policy,
        needsDecision: waits.length > 0,
        waits,
        tenantId: workspaceTenantId,
        anchorRunId: stage ? await currentAnchor(row.id) : null,
      };
    }),
  );
}

export async function projectDetail(projectId: string, actorPrincipalId: string) {
  const { db } = database();
  const row = await requireProject(projectId);
  const runs = await runsForProject(projectId);
  const nodes = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId))
    .orderBy(asc(table.artifactNode.createdAt));
  // Approvals, flags and questions are folded straight off the run's own
  // committed `/hub` events (PR #347's `foldRun`) rather than read back off
  // the ledger's own mail turns — the same fold the client applies.
  const foldedRuns = await foldedRunsFor(projectId);
  const approvals = projectApprovals(foldedRuns).map((approval, index) => ({
    id: `${approval.runId}:${index}`,
    runId: approval.runId,
    stage: approval.stage,
    command: approval.command,
    decision: approval.decision,
    audienceName: approval.audienceName,
    rationale: approval.rationale,
    createdAt: approval.at ?? "",
    versions: approval.versions,
  }));
  const flags = projectFlags(foldedRuns).map((flag) => ({
    id: flag.id,
    trigger: flag.trigger,
    classification: flag.classification,
    evidence: flag.evidence,
    chosenRoute: flag.chosenRoute,
    createdAt: flag.at ?? "",
  }));
  const questions = projectQuestions(foldedRuns).map((question) => ({
    id: question.id,
    prompt: question.prompt,
    answeredAt: question.answer?.at ?? null,
    answer: question.answer?.answer ?? null,
  }));
  const manifests = await deliveryManifests(projectId, nodes);

  const current = runs.filter((run) => run.endedAt === null).at(-1) ?? runs.at(-1) ?? null;
  const decision = await openDecisionFor(projectId, foldedRuns);
  const waits = decision ? [decision] : [];
  const soloApproval = current ? await soloApprovalFor(projectId, current.stage, actorPrincipalId) : false;

  const workspaceTenantId = tenantId();
  const anchorRunId = await currentAnchor(projectId);
  // The stage-1 opening statement and any turns carried in from another
  // instance are ledger data, not run events, so the client's fold of the
  // stage thread (`@solutions-builder/app/stage-thread`) cannot derive them
  // from `/hub` alone. They ride here instead.
  const opening = (await ledgerCommands(projectId)).find((command) => command.command === "project.create");
  const carriedTurns = await allCarriedTurns(projectId);

  return {
    project: { ...row, tenantId: workspaceTenantId, anchorRunId },
    tenantId: workspaceTenantId,
    anchorRunId,
    // Run standing is not folded here. The client reads committed `/hub` events
    // through `foldProject`; this GET is the ledger, artifacts, and the
    // tenant/anchor the fold addresses — not a second copy of the machine.
    runs,
    current,
    soloApproval,
    nodes,
    approvals,
    waits,
    flags,
    questions,
    manifests,
    opening:
      opening?.message ? { body: opening.message, createdAt: opening.createdAt } : null,
    carriedTurns,
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


/**
 * The delivery manifests are the artifact versions of that kind; acceptance
 * is the delivery.accept command recorded on the ledger after the manifest.
 */
async function deliveryManifests(
  projectId: string,
  nodes: (typeof table.artifactNode.$inferSelect)[],
): Promise<
  { id: string; manifestHash: string; acceptedAt: string | null; acceptedBy: string | null; descriptors: unknown }[]
> {
  const manifestNodes = nodes.filter((node) => node.kind === "delivery_manifest");
  if (manifestNodes.length === 0) return [];
  const acceptances = (await ledgerCommands(projectId)).filter((command) => command.command === "delivery.accept");
  return Promise.all(
    manifestNodes.map(async (node) => {
      const stored = await artifacts.get(node.artifactId);
      const body = stored ? (JSON.parse(stored.content) as { descriptors?: unknown }) : {};
      const accepted = acceptances.find((command) => command.createdAt >= node.createdAt.toISOString());
      return {
        id: node.id,
        manifestHash: node.contentHash,
        acceptedAt: accepted?.createdAt ?? null,
        acceptedBy: accepted?.actorPrincipalId ?? null,
        descriptors: body.descriptors ?? [],
      };
    }),
  );
}
