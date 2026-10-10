/**
 * Adopts projects made on `main` into the project workflow.
 *
 * A project made on `main` keeps its documents in the artifact store with no
 * `metadata.sb` and its position on a ledger session this product no longer
 * reads, so it opens here on stage 1 with nothing in it. This lands each
 * such project where `main` left it, by the workflow's own rules:
 *
 *   1. With the host stopped, reads every project's old ledger and node rows
 *      straight from the database, folds them (`@solutions-builder/app`'s
 *      `legacy-adoption.ts`), and stamps each artifact's current version with
 *      the `sb` metadata the graph reads. Only artifacts with no `sb` yet are
 *      touched, so a second run changes nothing.
 *   2. Starts the host, and as the workspace owner replays each stage's
 *      approval as real decisions on the project's workflow: open the
 *      review the old approval named, replay the stakeholders' votes and
 *      mint the requirement items where a stage needs them, approve. The
 *      reducer lands the stage and its ledger says how. Decision ids are
 *      deterministic, so a rerun is refused as duplicate rather than
 *      applied twice, and a stage the workflow already shows approved is
 *      skipped outright.
 *
 * Stage 7 is left to the person: its approval freezes a delivery target the
 * old ledger never recorded. A project past stage 6 is landed at 7 and the
 * report says so.
 *
 * Usage:
 *   bun scripts/adopt-legacy-projects.ts --dry-run          # the plan, nothing written
 *   bun scripts/adopt-legacy-projects.ts                    # adopt every project
 *   bun scripts/adopt-legacy-projects.ts --project <id>     # one project
 *
 * Honours SOLUTIONS_BUILDER_DATA_DIR. Run it against a copy first.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Transport } from "@intx/hub-client";
import { dataDirectory, databaseDirectory, openDatabase, type HostDatabase } from "@corbits/embedded-host";
import {
  ensureProjectWorkflow,
  resolveWorkspace,
  vendoredMemberFiles,
  workflowsFor,
  type ClosureSource,
  type ProjectWorkflowDeployment,
  type ProjectWorkflowStageInput,
  type SidecarCapability,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import {
  adoptionPlan,
  legacyArtifactMetadata,
  legacyPosition,
  type AdoptionPlan,
  type LegacyCommand,
  type LegacyEdge,
  type LegacyNode,
} from "@solutions-builder/app/legacy-adoption";
import { initSolutionsBuilderHost } from "../apps/hub/src/identity.js";
import { replayAdoption } from "../apps/web/src/adoption-replay.ts";
import type { StageApprovalDeps } from "../apps/web/src/stage-approval.ts";
import { loadProjectWorkflowView } from "../apps/web/src/project-workflow.ts";
import { closureAndPush, ownerTransport, startHost } from "./lib/owner-host.ts";
import { buildProjectWorkflowEntryFiles } from "./project-workflow-pack.ts";

const dryRun = process.argv.includes("--dry-run");
const onlyProject = ((): string | null => {
  const at = process.argv.indexOf("--project");
  return at === -1 ? null : (process.argv[at + 1] ?? null);
})();

initSolutionsBuilderHost();

type Row = Record<string, unknown>;
type ProjectRow = { id: string; title: string; policy: { audiences: { name: string }[]; audienceQuorum: number } };

/** `main`'s ledger session for a project: the same derivation its engine used. */
function ledgerSessionIdFor(projectId: string): string {
  return `ses_${createHash("sha256").update(`ledger:${projectId}`).digest("hex").slice(0, 24)}`;
}

async function rows<T extends Row>(host: HostDatabase, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await host.db.execute(query)).rows as T[];
}

// --- Phase 1: read the old shape, stamp the artifacts ------------------------

type Prepared = { project: ProjectRow; plan: AdoptionPlan; stamped: number; alreadyStamped: number };

async function prepare(host: HostDatabase): Promise<Prepared[]> {
  const projects = (
    await rows<{ id: string; title: string; config: { solutionsBuilder?: { policy?: ProjectRow["policy"]; deletedAt?: string | null } } }>(
      host,
      sql`select id, name as title, config from public.tenant where parent_id is not null and config -> 'solutionsBuilder' is not null order by created_at`,
    )
  )
    .filter((row) => !row.config.solutionsBuilder?.deletedAt)
    .filter((row) => onlyProject === null || row.id === onlyProject)
    .map((row) => ({ id: row.id, title: row.title, policy: row.config.solutionsBuilder?.policy ?? { audiences: [], audienceQuorum: 0 } }));

  const prepared: Prepared[] = [];
  for (const project of projects) {
    const commands = (
      await rows<{ metadata: LegacyCommand }>(
        host,
        sql`select p.metadata from public.turn_part p join public.inference_turn t on t.id = p.turn_id where p.session_id = ${ledgerSessionIdFor(project.id)} and p.metadata ->> 'kind' = 'command' order by t.started_at, p.ordinal`,
      )
    ).map((row) => row.metadata);
    if (commands.length === 0) continue; // never on `main`: nothing to adopt

    const nodes = (
      await rows<{
        id: string;
        project_id: string;
        artifact_id: string;
        version: number;
        kind: string;
        stage: number;
        variant: string | null;
        media_type: string;
        provenance: Record<string, unknown> | null;
        superseded_by_node_id: string | null;
      }>(host, sql`select id, project_id, artifact_id, version, kind, stage, variant, media_type, provenance, superseded_by_node_id from builder.artifact_node where project_id = ${project.id}`)
    ).map(
      (row): LegacyNode => ({
        id: row.id,
        projectId: row.project_id,
        artifactId: row.artifact_id,
        version: Number(row.version),
        kind: row.kind,
        stage: Number(row.stage),
        variant: row.variant,
        mediaType: row.media_type,
        provenance: row.provenance,
        supersededByNodeId: row.superseded_by_node_id,
      }),
    );
    const edges = (
      await rows<{ child_node_id: string; source_node_id: string }>(
        host,
        sql`select e.child_node_id, e.source_node_id from builder.artifact_edge e join builder.artifact_node n on n.id = e.child_node_id where n.project_id = ${project.id}`,
      )
    ).map((row): LegacyEdge => ({ childNodeId: row.child_node_id, sourceNodeId: row.source_node_id }));

    const contents = new Map<string, string>();
    const readContent = (artifactId: string, version: number): string | null => contents.get(`${artifactId}@${String(version)}`) ?? null;
    for (const node of nodes.filter((entry) => entry.kind === "product_requirements")) {
      const [row] = await rows<{ content: string }>(host, sql`select content from artifacts.artifact_version where artifact_id = ${node.artifactId} and version = ${node.version}`);
      if (row) contents.set(`${node.artifactId}@${String(node.version)}`, row.content);
    }

    const plan = adoptionPlan({ projectId: project.id, position: legacyPosition(commands), nodes, policy: project.policy, readContent });

    let stamped = 0;
    let alreadyStamped = 0;
    for (const entry of legacyArtifactMetadata(nodes, edges)) {
      const [artifact] = await rows<{ version: number; metadata: Record<string, unknown> | null }>(host, sql`select version, metadata from artifacts.artifact where id = ${entry.artifactId}`);
      if (!artifact) continue;
      if (artifact.metadata && typeof artifact.metadata === "object" && "sb" in artifact.metadata) {
        alreadyStamped += 1;
        continue;
      }
      if (!dryRun) {
        const metadata = JSON.stringify({ ...(artifact.metadata ?? {}), sb: entry.sb });
        await host.db.execute(sql`update artifacts.artifact set metadata = ${metadata}::jsonb, updated_at = now() where id = ${entry.artifactId}`);
        await host.db.execute(sql`update artifacts.artifact_version set metadata = ${metadata}::jsonb where artifact_id = ${entry.artifactId} and version = ${Number(artifact.version)}`);
      }
      stamped += 1;
    }
    prepared.push({ project, plan, stamped, alreadyStamped });
  }
  return prepared;
}

// --- Phase 2: replay through the running host as the owner -------------------

type Outcome = { project: ProjectRow; plan: AdoptionPlan; landed: number | null; stopped: string | null };

async function replay(transport: Transport, workspace: { tenantId: string; principalId: string }, sidecar: SidecarCapability, closure: ClosureSource, gitPush: WorkflowGitPush, entry: Prepared): Promise<Outcome> {
  const { project, plan } = entry;
  const stages: ProjectWorkflowStageInput[] = Array.from({ length: 9 }, (_, index) => ({ stage: index + 1, authorizedPrincipalIds: [workspace.principalId] }));
  // Always through `ensureProjectWorkflow`, the way the app opens a project:
  // it is what deploys a workflow the project lacks and what revives one
  // whose deployment has died since, replaying its decisions first.
  const deployment: ProjectWorkflowDeployment = await ensureProjectWorkflow(
    transport,
    sidecar,
    { files: await buildProjectWorkflowEntryFiles() },
    gitPush,
    project.id,
    stages,
    await vendoredMemberFiles(closure.manifest, closure.fetchTarball),
  );
  // `ensureProjectWorkflow` has already waited for the run to be placed and
  // caught up; `replayAdoption` waits for the run to report a stage.
  const deps: StageApprovalDeps = {
    view: () => loadProjectWorkflowView(transport, deployment),
    decide: async (_projectId, decision) => {
      await workflowsFor(transport, deployment.tenantId).signal(deployment.deploymentId, {
        runId: deployment.runId,
        signalName: "project.decision",
        signalId: decision["decisionId"] as string,
        payload: { decision },
      });
      return { ok: true as const };
    },
    now: () => new Date().toISOString(),
  };
  const outcome = await replayAdoption(deps, plan);
  return { project, plan, ...outcome };
}

// --- Main ------------------------------------------------------------------

const dataDir = dataDirectory();
const host = await openDatabase(databaseDirectory());
let prepared: Prepared[];
try {
  prepared = await prepare(host);
} finally {
  await host.close();
}

console.log(`${dryRun ? "Would adopt" : "Adopting"} ${String(prepared.length)} project(s) made on main in ${dataDir}:\n`);
for (const entry of prepared) {
  console.log(`- ${entry.project.title} (${entry.project.id}): stage ${String(entry.plan.legacyStage)} on the old ledger; replay stages ${entry.plan.steps.map((step) => String(step.stage)).join(", ") || "none"}; ${String(entry.stamped)} artifact(s) ${dryRun ? "to stamp" : "stamped"}, ${String(entry.alreadyStamped)} already stamped`);
  for (const note of entry.plan.notes) console.log(`    note: ${note}`);
}
if (dryRun || prepared.length === 0) process.exit(0);

console.log("\nStarting the host to replay the decisions…");
const running = await startHost(dataDir);
const outcomes: Outcome[] = [];
try {
  const { transport, cookie } = ownerTransport(running);
  await transport.fetch("POST", "/api/owner/session");
  const workspace = await resolveWorkspace(transport);
  if (!workspace) throw new Error("the workspace owner does not resolve through the host");
  const status = await transport.fetch<{ canPlaceSidecars?: boolean }>("GET", "/api/status");
  const sidecar: SidecarCapability = { canPlaceSidecars: status.canPlaceSidecars === true };
  const { closure, gitPush } = await closureAndPush(running, cookie, "scripts/adopt-legacy-projects.ts");
  for (const entry of prepared) {
    if (entry.plan.steps.length === 0) {
      outcomes.push({ project: entry.project, plan: entry.plan, landed: null, stopped: null });
      continue;
    }
    console.log(`\n${entry.project.title}: replaying…`);
    outcomes.push(await replay(transport, workspace, sidecar, closure, gitPush, entry).catch((cause: unknown) => ({ project: entry.project, plan: entry.plan, landed: null, stopped: cause instanceof Error ? cause.message : String(cause) })));
  }
} finally {
  await running.stop();
}

console.log("\nAdoption report:");
let failed = 0;
for (const outcome of outcomes) {
  const wanted = Math.min(outcome.plan.legacyStage, 7);
  const ok = outcome.stopped === null && (outcome.plan.steps.length === 0 || outcome.landed === wanted);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${outcome.project.title}: old ledger stage ${String(outcome.plan.legacyStage)}, workflow now at ${outcome.landed === null ? "-" : String(outcome.landed)}${outcome.stopped ? ` - ${outcome.stopped}` : ""}`);
  for (const note of outcome.plan.notes) console.log(`      ${note}`);
}
process.exit(failed === 0 ? 0 : 1);
