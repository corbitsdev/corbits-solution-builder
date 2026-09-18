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

/** One artifact node as carried between instances: the row, and the bytes the store holds for it. */
export type PortableArtifactNode = {
  id: string;
  artifactId: string;
  version: number;
  kind: string;
  variant: string | null;
  stage: number;
  title: string;
  mediaType: string;
  contentHash: string;
  sizeBytes: number;
  producerRunId: string | null;
  provenance: unknown;
  supersededByNodeId: string | null;
  createdAt: string;
  content: string;
};

/**
 * Every artifact node on a project with its content, oldest first, and the
 * lineage edges among them.
 *
 * The mounted module's HTTP surface has no route for a specific historical
 * version's body — only its current one (`GET /artifacts/:id`) and a
 * metadata-only version list. A superseded node (one with a
 * `supersededByNodeId`) therefore carries the artifact's CURRENT content here,
 * not the exact bytes it had at that version, which the in-process reader this
 * replaces was able to do. Every export is a real behavior change for any
 * project with a revised (not just superseded-by-a-new-kind) artifact.
 */
export async function exportArtifactNodes(projectId: string): Promise<{
  nodes: PortableArtifactNode[];
  edges: { childNodeId: string; sourceNodeId: string }[];
}> {
  const { db } = database();
  const rows = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId))
    .orderBy(asc(table.artifactNode.createdAt), asc(table.artifactNode.version));
  const contentByArtifactId = new Map<string, string>();
  const nodes: PortableArtifactNode[] = [];
  for (const row of rows) {
    if (!contentByArtifactId.has(row.artifactId)) {
      const stored = await artifacts.get(row.artifactId);
      contentByArtifactId.set(row.artifactId, stored?.content ?? "");
    }
    nodes.push({
      id: row.id,
      artifactId: row.artifactId,
      version: row.version,
      kind: row.kind,
      variant: row.variant,
      stage: row.stage,
      title: row.title,
      mediaType: row.mediaType,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      producerRunId: row.producerRunId,
      provenance: row.provenance,
      supersededByNodeId: row.supersededByNodeId,
      createdAt: row.createdAt.toISOString(),
      content: contentByArtifactId.get(row.artifactId) ?? "",
    });
  }
  const ids = new Set(nodes.map((node) => node.id));
  const edgeRows = await db.select().from(table.artifactEdge);
  const edges = edgeRows
    .filter((edge) => ids.has(edge.childNodeId))
    .map((edge) => ({ childNodeId: edge.childNodeId, sourceNodeId: edge.sourceNodeId }));
  return { nodes, edges };
}

/**
 * Writes carried-over artifact nodes into this instance under a new project.
 *
 * Version numbers, bytes, provenance, supersession and lineage are kept as
 * they were. The ids are not: the artifact store mints its own artifact
 * ids, and node ids are minted too, so a bundle can come back into the
 * workspace it left — a restored backup, a duplicated project — without
 * colliding with what is still there. The map returned says which id became
 * which, for both kinds, and the caller rewrites the ledger with it; here it
 * is applied to supersession, lineage, a feedback record's `variant`, and
 * the JSON body of any node that names other nodes, whose hash is then the
 * hash of what was written. Versions of one artifact go through the store's
 * own API in order so the numbers come out as they were; a gap in the carried
 * versions is refused rather than silently renumbered.
 */
export async function importArtifactNodes(args: {
  projectId: string;
  nodes: PortableArtifactNode[];
  edges: { childNodeId: string; sourceNodeId: string }[];
  actor: { principalId: string };
}): Promise<Map<string, string>> {
  const nodeIds = new Map<string, string>(args.nodes.map((node) => [node.id, newId.node()]));
  const renamed = (value: string | null): string | null => (value === null ? null : (nodeIds.get(value) ?? value));
  const { db } = database();
  // A JSON record that names other nodes — a design's feedback names the
  // design — is written with the new names, and its hash is of what was
  // written. Documents are bytes and are never touched.
  const contents = new Map<string, string>();
  const hashes = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const node of args.nodes) {
    if (node.kind !== "design_feedback") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(node.content);
    } catch {
      continue;
    }
    const rewritten = JSON.stringify(rewriteIds(parsed, nodeIds), null, 2);
    if (rewritten === node.content) continue;
    contents.set(node.id, rewritten);
    hashes.set(node.id, await sha256(rewritten));
    sizes.set(node.id, new TextEncoder().encode(rewritten).length);
  }
  const byArtifact = new Map<string, PortableArtifactNode[]>();
  for (const node of args.nodes) {
    byArtifact.set(node.artifactId, [...(byArtifact.get(node.artifactId) ?? []), node]);
  }
  // Written through the mounted module's own routes, in version order, one
  // artifact at a time — outside the builder transaction below, the same
  // service-boundary tradeoff `writeArtifact` takes.
  const artifactIds = new Map<string, string>();
  for (const [carriedId, versions] of byArtifact) {
    versions.sort((left, right) => left.version - right.version);
    let artifactId: string | null = null;
    for (const [index, node] of versions.entries()) {
      const expected = index + 1;
      if (node.version !== expected) {
        throw new HostError(
          "validation_failed",
          `Artifact ${carriedId} carries version ${node.version} where ${expected} was expected; the bundle is incomplete.`,
        );
      }
      if (artifactId === null) {
        const row = await artifacts.create({
          title: node.title,
          content: contents.get(node.id) ?? node.content,
        });
        artifactId = row.id;
        if (row.version !== node.version) {
          throw new HostError("internal_error", `The artifact store opened ${carriedId} at version ${row.version}.`);
        }
      } else {
        const revised = await artifacts.revise(artifactId, {
          title: node.title,
          content: contents.get(node.id) ?? node.content,
        });
        if (revised.version !== node.version) {
          throw new HostError("internal_error", `The artifact store wrote ${carriedId} v${node.version} as v${revised.version}.`);
        }
      }
    }
    artifactIds.set(carriedId, artifactId!);
  }
  await db.transaction(async (tx) => {
    for (const node of args.nodes) {
      await tx.insert(table.artifactNode).values({
        id: nodeIds.get(node.id)!,
        projectId: args.projectId,
        artifactId: artifactIds.get(node.artifactId)!,
        version: node.version,
        kind: node.kind,
        variant: renamed(node.variant),
        stage: node.stage,
        title: node.title,
        mediaType: node.mediaType,
        contentHash: hashes.get(node.id) ?? node.contentHash,
        sizeBytes: sizes.get(node.id) ?? node.sizeBytes,
        producerRunId: node.producerRunId,
        provenance: node.provenance as ArtifactDraft["provenance"],
        supersededByNodeId: renamed(node.supersededByNodeId),
        createdAt: new Date(node.createdAt),
      });
    }
    for (const edge of args.edges) {
      await tx.insert(table.artifactEdge).values({
        childNodeId: renamed(edge.childNodeId)!,
        sourceNodeId: renamed(edge.sourceNodeId)!,
      });
    }
  });
  return new Map([...artifactIds, ...nodeIds]);
}

/** Every string in `value` that is a key of `ids`, replaced by its value; the shape is otherwise untouched. */
export function rewriteIds(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteIds(item, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, rewriteIds(inner, ids)]),
    );
  }
  return value;
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
