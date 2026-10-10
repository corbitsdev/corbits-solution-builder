/**
 * Export and import of project bundles from a script, over a host session
 * held as the workspace owner (`owner-host.ts`).
 *
 * The bundle is the one the window writes and reads
 * (`apps/web/src/project-export.ts`, `project-import.ts`): the same
 * `assembleBundle` over the same reads, and the same `importProject`,
 * `bundleAdoptionPlan` and `replayAdoption` over the same writes, so a file
 * from either side imports on either side. What differs is only where the
 * reads and writes go: a transport into the host rather than the browser's
 * own cookie jar, and the workflow closure packed from this checkout rather
 * than fetched from the served interface.
 */
import type { Transport } from "@intx/hub-client";
import type { Stage } from "@solutions-builder/app/ledger";
import {
  createArtifact,
  createProject,
  ensureProjectWorkflow,
  getArtifactVersion,
  install,
  myPrincipalIn,
  resolveWorkspace,
  reviseArtifact,
  stageSpecialistAddresses,
  vendoredMemberFiles,
  visibleCatalog,
  workflowsFor,
  type ClosureSource,
  type ProjectPolicy,
  type ProjectWorkflowStageInput,
  type SidecarCapability,
  type Workspace,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import { replayAdoption } from "../../apps/web/src/adoption-replay.ts";
import { artifactGraphFor } from "../../apps/web/src/artifact-graph.ts";
import { bundleAdoptionPlan } from "../../apps/web/src/bundle-adoption.ts";
import { isLegacyBundle } from "../../apps/web/src/legacy-import.ts";
import { findArtifact } from "../../apps/web/src/project-artifacts.ts";
import { assembleBundle, parseBundle, type ProjectBundle } from "../../apps/web/src/project-export.ts";
import { importProject, type ImportResult } from "../../apps/web/src/project-import.ts";
import { listProjectSummaries } from "../../apps/web/src/project-list.ts";
import type { ProjectSummary } from "../../apps/web/src/client.ts";
import { parentTenantOf, addressesByMailTenant } from "../../apps/web/src/project-tenants.ts";
import { loadProjectView } from "../../apps/web/src/project-view.ts";
import { resolveProjectWorkflowRef } from "../../apps/web/src/project-workflow-ref.ts";
import { loadProjectWorkflowView } from "../../apps/web/src/project-workflow.ts";
import { digestOf, type StageApprovalDeps } from "../../apps/web/src/stage-approval.ts";
import { readStageThread } from "../../apps/web/src/stage-mail.ts";
import { buildProjectWorkflowEntryFiles } from "../project-workflow-pack.ts";
import type { OwnerSession } from "./owner-host.ts";

export { type ProjectBundle, type ProjectSummary };

export async function listProjects(transport: Transport): Promise<ProjectSummary[]> {
  return listProjectSummaries(transport);
}

/** A blob-backed artifact's bytes as the `data:` URL the bundle carries, read
 *  through the hub's own download route; an older upload can still sit in
 *  the workspace tenant (#29), so a 404 is asked again of the parent. */
async function downloadAsDataUrl(session: OwnerSession, tenantId: string, artifactId: string): Promise<string> {
  const response = await session.fetchRaw(`/api/tenants/${encodeURIComponent(tenantId)}/artifacts/${encodeURIComponent(artifactId)}/download`);
  if (response.status === 404) {
    const parentId = await parentTenantOf(session.transport, tenantId).catch(() => null);
    if (parentId) return downloadAsDataUrl(session, parentId, artifactId);
  }
  if (!response.ok) throw new Error(`downloading artifact ${artifactId}: HTTP ${String(response.status)}`);
  const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
  return `data:${mimeType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

/** The bundle for one project: what the window's Export… writes. */
export async function exportProject(session: OwnerSession, projectId: string): Promise<ProjectBundle> {
  const { transport } = session;
  return assembleBundle(projectId, {
    projectView: (id) => loadProjectView(id, transport),
    artifactVersions: async (tenantId, nodeId) => {
      const found = await findArtifact(transport, tenantId, nodeId);
      if (!found) return [];
      const { artifact } = found;
      const uploadId = (artifact.source as { upload?: { id?: unknown } }).upload?.id;
      if (typeof uploadId === "string") return [{ version: artifact.version, content: await downloadAsDataUrl(session, found.tenantId, nodeId) }];
      const earlier = await Promise.all(Array.from({ length: artifact.version - 1 }, (_, at) => getArtifactVersion(transport, found.tenantId, nodeId, at + 1)));
      return [...earlier.flatMap((row) => (row ? [{ version: row.version, content: row.content }] : [])), { version: artifact.version, content: artifact.content }];
    },
    artifactEdges: (id) => artifactGraphFor(transport, id).then((graph) => graph.edges),
    stageAgentAddresses: (id, stage) => stageSpecialistAddresses(transport, id, stage as Stage),
    readStageThread: async (tenantId, addresses) => {
      const groups = await addressesByMailTenant(transport, tenantId, addresses);
      const threads = await Promise.all([...groups.entries()].map(([mailTenantId, grouped]) => readStageThread(mailTenantId, grouped, transport)));
      return threads.flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    },
    workflowView: async (id) => {
      const ref = await resolveProjectWorkflowRef(transport, id);
      return ref ? loadProjectWorkflowView(transport, ref) : null;
    },
  });
}

/** `sb-` and twelve base-36 characters: the slug the window gives a new project. */
export function projectSlug(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "sb-";
  for (const byte of bytes) out += alphabet[byte % alphabet.length]!;
  return out;
}

/** The bundle `value` holds, or why it is not one this import takes. */
export function bundleOf(value: unknown): ProjectBundle {
  if (isLegacyBundle(value)) {
    throw new Error("this is a version 1 bundle from main; the window's Import a project reads it, this script does not");
  }
  return parseBundle(value);
}

export type ImportOutcome = {
  readonly projectId: string;
  readonly title: string;
  readonly artifacts: number;
  readonly versions: number;
  readonly conversations: number;
  /** The stage the workflow reports after the replay; null when there was nothing to replay. */
  readonly landed: number | null;
  /** Why the replay stopped short, when it did. */
  readonly stopped: string | null;
  readonly notes: readonly string[];
};

export type ImportContext = {
  readonly session: OwnerSession;
  readonly workspace: Workspace;
  readonly sidecar: SidecarCapability;
  readonly closure: ClosureSource;
  readonly gitPush: WorkflowGitPush;
  readonly onProgress?: (line: string) => void;
};

/**
 * Refuses an import before anything is written when the instance has no
 * model provider: the new project's workflow runs on one, so the bundle's
 * position could not be replayed and the project would land at stage 1
 * with its documents but none of its decisions.
 */
export async function requireProvider(transport: Transport, workspace: Workspace): Promise<void> {
  const catalog = await visibleCatalog(transport, workspace.tenantId);
  if (catalog.offerings.length === 0) {
    throw new Error("this instance has no model provider connected; connect one in the window's Settings first, since the imported project's workflow runs on it");
  }
}

/** The workspace the host serves, installed first when the window never has. */
export async function ensureWorkspace(transport: Transport): Promise<Workspace> {
  const known = await resolveWorkspace(transport);
  if (known) return known;
  await install(transport);
  const installed = await resolveWorkspace(transport);
  if (!installed) throw new Error("the workspace did not resolve after install");
  return installed;
}

/**
 * Imports one bundle as a new project, as the window's import does: the
 * artifacts and conversations written fresh under a new project id, then
 * the bundle's position replayed as real decisions on the new project's own
 * workflow (#652). A replay that stops short is reported, not thrown: the
 * project is imported either way.
 */
export async function importBundle(bundle: ProjectBundle, context: ImportContext): Promise<ImportOutcome> {
  const { transport } = context.session;
  const say = context.onProgress ?? (() => undefined);
  const written: ImportResult = await importProject(bundle, {
    createProject: async ({ title, policy }) => {
      const { project } = await createProject(transport, context.workspace.tenantId, { title, slug: projectSlug(), policy: policy as ProjectPolicy });
      return { projectId: project.id };
    },
    createArtifact: async ({ title, content, sb }) => {
      const artifact = await createArtifact(transport, sb.projectId as string, { title, content, metadata: { sb } });
      return { id: artifact.id, version: artifact.version };
    },
    reviseArtifact: async (artifactId, { title, content, sb }) => {
      const artifact = await reviseArtifact(transport, sb.projectId as string, artifactId, { title, content, metadata: { sb } });
      return { version: artifact.version };
    },
    onProgress: (done, total) => {
      if (done === total || done % 25 === 0) say(`  wrote ${String(done)} of ${String(total)}`);
    },
  });
  const title = `${bundle.project.title} (imported)`;
  const counts = { projectId: written.projectId, title, artifacts: written.artifacts, versions: written.versions, conversations: written.conversations };

  const digests = new Map<string, string>();
  for (const { node, content } of bundle.artifacts) {
    if (node.kind === "source_material" || node.kind === "material_reading") continue;
    digests.set(node.id, await digestOf(content));
  }
  const plan = bundleAdoptionPlan(bundle, written.projectId, written.written, digests);
  if (plan.steps.length === 0) return { ...counts, landed: null, stopped: null, notes: plan.notes };

  say(`  starting the project's workflow to replay ${String(plan.steps.length)} decision step(s)`);
  try {
    // The owner is a different principal in the project's own tenant, and
    // the hub stamps a decision with the caller's principal there; both
    // authorise every stage, as the window's ensure arranges (#165).
    const ownerInProject = await myPrincipalIn(transport, written.projectId);
    const authorizedPrincipalIds = [...new Set([...(ownerInProject ? [ownerInProject] : []), context.workspace.principalId])];
    const stages: ProjectWorkflowStageInput[] = Array.from({ length: 9 }, (_, index) => ({ stage: index + 1, authorizedPrincipalIds }));
    const deployment = await ensureProjectWorkflow(
      transport,
      context.sidecar,
      { files: await buildProjectWorkflowEntryFiles() },
      context.gitPush,
      written.projectId,
      stages,
      await vendoredMemberFiles(context.closure.manifest, context.closure.fetchTarball),
    );
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
    const landing = await replayAdoption(deps, plan);
    return { ...counts, ...landing, notes: plan.notes };
  } catch (cause) {
    return { ...counts, landed: null, stopped: cause instanceof Error ? cause.message : String(cause), notes: plan.notes };
  }
}
