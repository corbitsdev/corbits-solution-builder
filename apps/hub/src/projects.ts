/**
 * Project and artifact-graph writes.
 *
 * `project.create` is separate from the command engine because it is the one
 * command with no source run to guard — the ledger's only `from: null` row.
 * Artifact writes are here too: they are how a stage produces something, and
 * they never transition anything.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { createArtifact, writeArtifactVersion } from "@corbits/artifacts";
import { database } from "./db.js";
import { withPostgresJsResultShape } from "@solutions-builder/embed-hub/pg-compat";
import * as table from "./schema.js";
import { newId, sha256 } from "./ids.js";
import { HostError, notFound } from "./errors.js";
import { origin } from "@solutions-builder/app/guard";
import { ARTIFACT_STAGE, type ArtifactDraft } from "./domain.js";
import { packageOutlineProblem } from "@solutions-builder/app/deck";
import { launchProjectRun, soloApprovalFor } from "./command-dispatch.js";
import { ledgerCommands, recordCommand, projectApprovals, projectFlags, projectQuestions } from "./command-ledger.js";
import type { Stage } from "@solutions-builder/app/ledger";
import { nextQuestion } from "./questions.js";
import { openDecisionFor } from "./decisions.js";
import { currentAnchor, projectExecutionStatus } from "./lifecycle-run.js";
import { activeRun, runsForProject } from "./runs.js";
import { tenantId } from "./hub-client.js";
import { listProjectRecords, requireProject, updateProject } from "./project-records.js";

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
  await launchProjectRun({ projectId: args.projectId });
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

  const scope = {
    tenantId: tenantId(),
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
  await updateProject(projectId, { title });
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

/** Every artifact node on a project with its content, oldest first, and the lineage edges among them. */
export async function exportArtifactNodes(projectId: string): Promise<{
  nodes: PortableArtifactNode[];
  edges: { childNodeId: string; sourceNodeId: string }[];
}> {
  const { db, artifactDb } = database();
  const { getArtifactVersion } = await import("@corbits/artifacts");
  const rows = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId))
    .orderBy(asc(table.artifactNode.createdAt), asc(table.artifactNode.version));
  const nodes: PortableArtifactNode[] = [];
  for (const row of rows) {
    const stored = await getArtifactVersion(artifactDb, row.artifactId, row.version);
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
      content: stored?.content ?? "",
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
  const { db, artifactDb } = database();
  const scope = {
    tenantId: tenantId(),
    principalId: args.actor.principalId,
    identity: { kind: "user" as const, principalId: args.actor.principalId },
  };
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
  const artifactIds = new Map<string, string>();
  await db.transaction(async (tx) => {
    const artifactTx = withPostgresJsResultShape(tx) as unknown as typeof artifactDb;
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
        const producer = (node.provenance as { producer?: string } | null)?.producer;
        if (artifactId === null) {
          const row = await createArtifact(artifactTx as never, {
            scope,
            ownerPrincipalId: args.actor.principalId,
            kind: "document",
            title: node.title,
            content: contents.get(node.id) ?? node.content,
            source: { origin: producer === "agent" ? "agent" : "manual" },
          });
          artifactId = row.id;
          if (row.version !== node.version) {
            throw new HostError("internal_error", `The artifact store opened ${carriedId} at version ${row.version}.`);
          }
        } else {
          const revised = await writeArtifactVersion(artifactTx, {
            scope,
            artifactId,
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
  const projects = await listProjectRecords();

  return Promise.all(
    projects.map(async (row) => {
      const current = await activeRun(row.id);
      const decision = await openDecisionFor(row.id, current);
      const waits = decision ? [decision] : [];
      // Whose move it is on the current stage. "In progress" alone cannot tell
      // a list apart: the model writing, a question waiting on the person and
      // a draft waiting to be approved are all "in progress".
      const stage = current?.stage ?? null;
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
            nextQuestion(row.id, stage),
          ])
        : [[], null];
      const turn: "writing" | "question" | "approve" | "idle" = open
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
        policy: row.policy,
        needsDecision: waits.length > 0,
        waits,
      };
    }),
  );
}

export async function projectDetail(projectId: string, actorPrincipalId: string) {
  const { db } = database();
  const row = await requireProject(projectId);
  // The ledger follows the run: a gate a person signalled over `/hub` becomes
  // a ledger turn here, before the runs and approvals below are read.
  await projectExecutionStatus(projectId).catch((cause: unknown) => {
    console.error(`[executor] ${projectId}: could not read the run before the project:`, cause);
  });

  const runs = await runsForProject(projectId);
  const nodes = await db
    .select()
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId))
    .orderBy(asc(table.artifactNode.createdAt));
  const approvals = await projectApprovals(projectId);
  const flags = await projectFlags(projectId);
  const questions = await projectQuestions(projectId);
  const manifests = await deliveryManifests(projectId, nodes);

  const current = runs.filter((run) => run.endedAt === null).at(-1) ?? runs.at(-1) ?? null;
  const decision = await openDecisionFor(projectId, current);
  const waits = decision ? [decision] : [];
  const soloApproval = current ? await soloApprovalFor(projectId, current.stage, actorPrincipalId) : false;

  const workspaceTenantId = tenantId();
  const anchorRunId = await currentAnchor(projectId);

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
  const { artifactDb } = database();
  const { getArtifactVersion } = await import("@corbits/artifacts");
  const acceptances = (await ledgerCommands(projectId)).filter((command) => command.command === "delivery.accept");
  return Promise.all(
    manifestNodes.map(async (node) => {
      const stored = await getArtifactVersion(artifactDb, node.artifactId, node.version);
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
