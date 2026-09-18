/**
 * The API client.
 *
 * The one place the interface talks to the host. Every call goes through
 * `request`, so an error contract change is a change here and nowhere else.
 * Clients read and command; they never write persistence.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { triggerWorkflowRun } from "@intx/hub-client";
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-prompt";
import {
  ApiError as HubApiError,
  createArtifact as installerCreateArtifact,
  createProject as installerCreateProject,
  ensureLifecycleDeployment as installerEnsureLifecycleDeployment,
  getArtifact as installerGetArtifact,
  install as installerInstall,
  installState as installerInstallState,
  installProjectAuthority,
  InstallerError,
  liveDelegationStore,
  ensureRegistryTarballs,
  pushSourceTree,
  requireProject as installerRequireProject,
  resolveWorkspace,
  revokeAllDelegations,
  updateProject as installerUpdateProject,
  type ClosureManifest,
  type ClosureSource,
  type InstallState as PackageInstallState,
  type ProjectPolicy,
  type RegistryTarballUploader,
  type SidecarCapability,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import { MATERIAL_KIND } from "@solutions-builder/app/artifacts";
import { artifactGraphFor } from "./artifact-graph.ts";
import { openCreatedProject } from "./create-project-open.ts";
import { createHubTransport } from "./hub.ts";
import { listProjectSummaries } from "./project-list.ts";
import { openDecisions } from "./decisions-fold.ts";
import { loadProjectView, toArtifactNode } from "./project-view.ts";
import { designerSettings as loadDesignerSettings, saveDesignerSettings, type DesignerSettings } from "./designer-settings.ts";
import {
  API_KEY_CONNECT_OPTIONS,
  OAUTH_CONNECT_OPTIONS,
  connectApiKeyProvider,
  connectOAuthProvider,
  disconnectProvider,
  listConnectedProviders,
  rerankCatalogViaHub,
  reorderProviders,
  selectProviderModel,
} from "./provider-catalog.ts";

export type { DesignerSettings } from "./designer-settings.ts";

export { createHubTransport } from "./hub.ts";

export type Remediation = {
  kind: "switch_provider" | "reconnect" | "retry";
  label: string;
  providerId?: string;
};

export type ApiError = {
  code: string;
  message: string;
  correlationId: string;
  retryable: boolean;
  refusal?: string;
  /** What the interface can offer beyond the message. */
  remediation?: Remediation;
  /** The workspace is not installed; the call is valid once it is. */
  install?: boolean;
};

export class ApiFailure extends Error {
  readonly detail: ApiError;
  constructor(detail: ApiError) {
    super(detail.message);
    this.name = "ApiFailure";
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    // The request never reached the host. A raw `TypeError: Load failed` is not
    // something to show a person, and it says nothing about what to do.
    //
    // The message deliberately does not assert the host died: the same failure
    // covers a dropped connection and a request made while the host was
    // restarting. Claiming a cause that may be wrong is worse than describing
    // what happened.
    throw new ApiFailure({
      code: "host_unreachable",
      message: "That request did not reach the host. Try again, or reopen the window.",
      correlationId: "-",
      retryable: true,
    });
  }

  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (body as { error?: ApiError }).error;
    throw new ApiFailure(
      detail ?? {
        code: "internal_error",
        message: `The host answered ${response.status}.`,
        correlationId: "-",
        retryable: false,
      },
    );
  }
  return body as T;
}

const post = <T>(path: string, payload?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(payload ?? {}) });

export type HostStatus = {
  apiVersion: string;
  host: {
    state: string;
    startedAt: string;
    pid: number;
    connectedClients: number;
    sleepGaps: { from: string; to: string; seconds: number }[];
    windowlessWorkContinues: true;
  };
  credentialBackend: "keychain" | "file";
  canPlaceSidecars: boolean;
  sidecarFingerprint: string | null;
  hub: {
    mode: "embedded" | "remote";
    url: string | null;
    ready: boolean;
    detail: string;
    reported: { status?: string } | null;
  };
  /** Absent while the host's build-worker bridge is mid-removal (CL-8072). */
  build?: {
    integration: string;
    /** The worker stage 8 runs now, and the executable it resolves to. */
    worker: { id: string; label: string; command: string };
    /** Every worker the bridge knows how to run, in the order Settings offers them. */
    workers: { id: string; label: string; executable: string }[];
    available: boolean;
    detail: string;
    capabilities: Record<string, boolean>;
  };
};

export type Provider = {
  id: string;
  providerId: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  status: string;
  statusDetail: string | null;
  models: string[];
  active: boolean;
  priority: number;
  hasCredential: boolean;
  validatedAt: string | null;
  selectedModel: string | null;
};

export type Wait = {
  id: string;
  projectId: string;
  projectTitle?: string;
  runId: string;
  stage: number;
  title: string;
  consequence: string;
  blockers: string | null;
  requiredAuthority: string;
};

export type ProjectSummary = {
  id: string;
  revision: number;
  title: string;
  stage: number | null;
  state: string | null;
  runId: string | null;
  archivedAt: string | null;
  needsDecision: boolean;
  waits: Wait[];
  /**
   * Whose move it is on the current stage. Host-computed as `"approve"` or
   * `"idle"` only — the open-question case is folded client-side, from
   * `tenantId`/`anchorRunId`, the same way the workspace's own thread is.
   */
  turn: "writing" | "question" | "approve" | "idle";
  question?: { ordinal: number; remaining: number };
  /** Workspace tenant the lifecycle is deployed in — for the client's open-question fold. */
  tenantId: string;
  /** Deployment id of the project's lifecycle run, or null when none is placed. */
  anchorRunId: string | null;
};

export type ProjectInfo = {
  project: { id: string; title: string; createdAt: string; archivedAt: string | null };
  stage: { stage: number; state: string } | null;
  artifacts: { versions: number; live: number; bytes: number; byKind: { kind: string; count: number; bytes: number }[] };
  runs: { total: number; builds: number };
  approvals: number;
  lastActivityAt: string;
};

export type ArtifactNode = {
  id: string;
  kind: string;
  variant: string | null;
  stage: number;
  title: string;
  version: number;
  artifactId: string;
  contentHash: string;
  sizeBytes: number;
  /** `text/markdown` for a written document, `text/html` for a design. */
  mediaType?: string;
  createdAt: string;
  supersededByNodeId: string | null;
  /** `stepRef` is the stage-thread fold's lookup key: `${iterationRunId}/${stepId}` for the step that wrote this version. */
  provenance: { producer: string; agentRole?: string; providerId?: string; model?: string; stepRef?: string };
};

export type Run = {
  id: string;
  kind: string;
  stage: number;
  /**
   * Coarsened from the host's own ledger-run states: `loadProjectView`
   * (`./project-view.ts`) folds only what the stage workspace actually
   * branches on — `"in_progress"`, `"waiting_approval"`, and stage 7's
   * `"cost_approved"` hand-off to the freeze — from the run fold's own
   * parked/running signal. See that file's header for what this drops.
   */
  state: string;
  createdAt: string;
  endedAt: string | null;
  terminalReason: string | null;
  packetId: string | null;
};

/** One worker event on a build run, as the host recorded it. */
export type BuildEvent = {
  id: string;
  runId: string;
  type: string;
  severity: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type ProjectDetail = {
  project: {
    id: string;
    title: string;
    policy: unknown;
    archivedAt: string | null;
    /** Workspace tenant the lifecycle is deployed in — for `/hub` fold and signal. */
    tenantId: string;
    /** Deployment id of the project's lifecycle run, or null when none is placed. */
    anchorRunId: string | null;
  };
  /** Same as `project.tenantId`; the workspace the run is folded in. */
  tenantId: string;
  /** Same as `project.anchorRunId`. */
  anchorRunId: string | null;
  runs: Run[];
  current: Run | null;
  /** True when no principal other than the local actor holds this stage's approval authority. */
  soloApproval: boolean;
  nodes: ArtifactNode[];
  approvals: {
    id: string;
    runId: string;
    stage: number;
    command: string;
    decision: string;
    audienceName: string | null;
    rationale: string | null;
    createdAt: string;
    versions: { versionId: string; contentHash: string }[];
  }[];
  /**
   * The stage-1 opening problem statement, read off the anchor run's own
   * `RunStarted` trigger event (`./run-fold.ts`'s `foldOpening`) now, not the
   * ledger's `project.create` command.
   */
  opening: { body: string; createdAt: string } | null;
  /**
   * Turns carried in from another project instance on import. Always empty
   * now — `GET /projects/:id` read this off `command-ledger.ts`, which has
   * no run-event fold; project-transfer needs its own client fold to bring
   * this back.
   */
  carriedTurns: { stage: number; turn: StageTurn }[];
};

export type { Quote, StageTurn };

/** The stage-1 brief evaluator's verdict. Advisory only — nothing gates on it. */
export type Evaluation = { ready: boolean; notes: string[] };

export type InstallState = PackageInstallState;

const HOSTED_INSTALL: InstallState = {
  installed: true,
  appVersion: APP_VERSION,
  missing: [],
  stale: [],
  deployment: { status: "hosted", detail: "Managed by the hub." },
  detail: "Hosted hub: definitions are managed there.",
};

const TITLE_MAX = 60;
const SLUG_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** The fallback name: first line of the problem, trimmed to a title. */
export function titleFromProblem(problem: string): string {
  const line = problem.trim().split("\n")[0]!.trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

function projectSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "sb-";
  for (const byte of bytes) out += SLUG_ALPHABET[byte % SLUG_ALPHABET.length]!;
  return out;
}

/**
 * Reorder offerings by what each provider can serve, over hub catalog
 * routes. The installer package cannot judge that; credential
 * connect/disconnect re-runs install, and this is how that install still
 * reranks without a host provider-domain call.
 */
export async function rerankCatalogAfterSkillAssets(): Promise<void> {
  try {
    await rerankCatalogViaHub(createHubTransport());
  } catch (cause) {
    installerFailure(cause);
  }
}

export function sidecarCapabilityOf(
  status: Pick<HostStatus, "canPlaceSidecars" | "sidecarFingerprint">,
): SidecarCapability {
  const fingerprint = status.sidecarFingerprint;
  if (!status.canPlaceSidecars || fingerprint === null || fingerprint.length === 0) {
    return { canPlaceSidecars: false, sidecarFingerprint: "" };
  }
  return { canPlaceSidecars: true, sidecarFingerprint: fingerprint };
}

/**
 * A `RegistryTarballUploader` over the hub's own `/hub` passthrough, for one
 * tenant scope. `createHubTransport`'s `Transport.fetch` always JSON-encodes
 * its body, so the tarball's raw bytes are PUT with a plain `fetch` instead,
 * the same `/hub`-prefixed, same-origin-credentialed route the rest of the
 * browser client uses.
 */
function hubTarballUploaderFor(scope: string): RegistryTarballUploader {
  return {
    async putTarball(assetId, filename, bytes) {
      const response = await fetch(`/hub/api/tenants/${encodeURIComponent(scope)}/assets/${assetId}/tarballs/${filename}`, {
        method: "PUT",
        credentials: "same-origin",
        body: new Uint8Array(bytes),
      });
      if (!response.ok) {
        throw new Error(`tarball upload failed: ${filename} (HTTP ${String(response.status)})`);
      }
    },
  };
}

/**
 * Makes the workspace's registry asset hold every tarball
 * `scripts/pack-closure-static.ts` shipped, uploading only what is missing.
 * Best-effort and non-blocking: a dev tree without the static closure built
 * (`bun run assets:pack-closure`), or a hub that cannot be reached, must not
 * fail `install()` — this is the `format: "tarball"` deploy arm's own asset
 * (CL-8382/PR #333), separate from the `format: "source"` lifecycle push
 * `lifecycleClosureSource`/`lifecycleGitPush` drive below (CL-8334).
 */
async function ensureClosureRegistryAsset(tenantId: string): Promise<void> {
  try {
    const manifest = await fetchClosureManifestOrThrow();
    await ensureRegistryTarballs(
      createHubTransport(),
      tenantId,
      hubTarballUploaderFor(tenantId),
      manifest,
      fetchClosureTarball,
    );
  } catch (cause) {
    console.warn("ensureClosureRegistryAsset failed", cause);
  }
}

/** The static closure manifest `scripts/pack-closure-static.ts` writes to
 *  `apps/web/public/closure/manifest.json` (wired into `bun run ui:build`).
 *  Throws when the manifest is missing or unreachable, rather than
 *  returning null, so a caller that needs the closure (the lifecycle push)
 *  fails loudly instead of silently deploying an empty tree. */
async function fetchClosureManifestOrThrow(): Promise<ClosureManifest> {
  const response = await fetch("/closure/manifest.json", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`closure manifest unavailable (HTTP ${String(response.status)})`);
  return (await response.json()) as ClosureManifest;
}

async function fetchClosureTarball(filename: string): Promise<Uint8Array> {
  const tarball = await fetch(`/closure/${filename}`, { credentials: "same-origin" });
  if (!tarball.ok) throw new Error(`could not fetch closure tarball ${filename}`);
  return new Uint8Array(await tarball.arrayBuffer());
}

/** The lifecycle deploy's closure source: the same static tarballs
 *  `ensureClosureRegistryAsset` uploads, read back and extracted in the
 *  browser rather than uploaded to a registry asset (CL-8334). */
async function lifecycleClosureSource(): Promise<ClosureSource> {
  return { manifest: await fetchClosureManifestOrThrow(), fetchTarball: fetchClosureTarball };
}

/**
 * Pushes the lifecycle's rendered tree into its `workflow`-kind asset over
 * the hub's stock git smart-HTTP route, the same stock-routes path
 * `corbitsdev/workbench` PR #861 took for Myra: isomorphic-git in the
 * browser speaks the pack, this file only supplies the `/hub`-prefixed,
 * same-origin-credentialed URL `pushSourceTree` cannot construct itself
 * (it does not know the host mounts the hub at `/hub`).
 */
const lifecycleGitPush: WorkflowGitPush = ({ scope, assetKind, assetName, token, tree, message }) => {
  const url = new URL(
    `/hub/api/tenants/${encodeURIComponent(scope)}/assets/${assetKind}/${assetName}.git`,
    window.location.origin,
  ).toString();
  return pushSourceTree({ url, token, tree, message });
};

function installerFailure(cause: unknown): never {
  if (cause instanceof ApiFailure) throw cause;
  if (cause instanceof InstallerError) {
    throw new ApiFailure({
      code: cause.code,
      message: cause.message,
      correlationId: "-",
      retryable: false,
    });
  }
  if (cause instanceof HubApiError) {
    throw new ApiFailure({
      code: cause.code,
      message: cause.message,
      correlationId: "-",
      retryable: cause.code === "host_unreachable",
    });
  }
  throw new ApiFailure({
    code: "internal_error",
    message: cause instanceof Error ? cause.message : String(cause),
    correlationId: "-",
    retryable: false,
  });
}

async function asWorkspaceOwner<T>(
  work: (transport: ReturnType<typeof createHubTransport>, workspaceTenantId: string) => Promise<T>,
): Promise<T> {
  try {
    const transport = createHubTransport();
    const workspace = await resolveWorkspace(transport);
    if (!workspace) {
      throw new ApiFailure({
        code: "conflict",
        message: "The workspace is not installed yet.",
        correlationId: "-",
        retryable: false,
        install: true,
      });
    }
    return await work(transport, workspace.tenantId);
  } catch (cause) {
    installerFailure(cause);
  }
}

const STAKEHOLDER_ROLES: readonly Authority[] = AUTHORITIES.filter((role) => role !== "system");
const MAX_STAKEHOLDER_NAME = 80;

function stakeholdersPolicy(
  current: ProjectPolicy,
  payload: { audiences: { name: string; role: string }[]; audienceQuorum: number },
): ProjectPolicy {
  const audiences: { name: string; role: Authority }[] = [];
  for (const entry of payload.audiences) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length === 0) {
      throw new ApiFailure({
        code: "validation_failed",
        message: "Every stakeholder needs a name.",
        correlationId: "-",
        retryable: false,
      });
    }
    if (name.length > MAX_STAKEHOLDER_NAME) {
      throw new ApiFailure({
        code: "validation_failed",
        message: `${name.slice(0, 20)}… is too long a name; ${MAX_STAKEHOLDER_NAME} characters at most.`,
        correlationId: "-",
        retryable: false,
      });
    }
    if (audiences.some((held) => held.name.toLowerCase() === name.toLowerCase())) {
      throw new ApiFailure({
        code: "validation_failed",
        message: `${name} is listed twice.`,
        correlationId: "-",
        retryable: false,
      });
    }
    const role = entry.role as Authority;
    if (!STAKEHOLDER_ROLES.includes(role)) {
      throw new ApiFailure({
        code: "validation_failed",
        message: `${name} has a role this project does not know: ${String(entry.role)}.`,
        correlationId: "-",
        retryable: false,
      });
    }
    audiences.push({ name, role });
  }
  if (audiences.length === 0) {
    throw new ApiFailure({
      code: "validation_failed",
      message: "A project needs at least one stakeholder.",
      correlationId: "-",
      retryable: false,
    });
  }
  const quorum = Number(payload.audienceQuorum);
  if (!Number.isInteger(quorum) || quorum < 0 || quorum > audiences.length) {
    throw new ApiFailure({
      code: "validation_failed",
      message: `The quorum must be a whole number from 0 to ${audiences.length}.`,
      correlationId: "-",
      retryable: false,
    });
  }
  return { ...current, audiences, audienceQuorum: quorum };
}

export const api = {
  status: () => request<HostStatus>("/status"),
  installState: async (): Promise<InstallState> => {
    const status = await request<HostStatus>("/status");
    if (status.hub.mode !== "embedded") return HOSTED_INSTALL;
    try {
      return await installerInstallState(createHubTransport());
    } catch (cause) {
      installerFailure(cause);
    }
  },
  install: async (): Promise<InstallState> => {
    const status = await request<HostStatus>("/status");
    if (status.hub.mode !== "embedded") return HOSTED_INSTALL;
    try {
      const state = await installerInstall(
        createHubTransport(),
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        { afterSkillAssets: rerankCatalogAfterSkillAssets },
      );
      const workspace = await resolveWorkspace(createHubTransport());
      if (workspace) void ensureClosureRegistryAsset(workspace.tenantId);
      return state;
    } catch (cause) {
      installerFailure(cause);
    }
  },
  agents: () => request<{ agents: { id: string; title: string; mission: string; stages: number[]; boundary: string }[] }>("/agents"),
  providers: async () => {
    try {
      return {
        providers: await listConnectedProviders(createHubTransport()),
        apiKeyProviders: [...API_KEY_CONNECT_OPTIONS],
        oauthCandidates: [...OAUTH_CONNECT_OPTIONS],
      };
    } catch (cause) {
      installerFailure(cause);
    }
  },
  connectProvider: async (input: { providerId: string; label: string; baseUrl?: string; apiKey: string }): Promise<Provider> => {
    try {
      return await connectApiKeyProvider(createHubTransport(), input);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  connectOAuthProvider: async (input: { providerId: string; label: string }): Promise<void> => {
    try {
      await connectOAuthProvider(createHubTransport(), input);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  disconnectProvider: async (providerId: string): Promise<void> => {
    try {
      await disconnectProvider(createHubTransport(), providerId);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  reorderProviders: async (orderedProviderIds: string[]): Promise<void> => {
    try {
      await reorderProviders(createHubTransport(), orderedProviderIds);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  selectProviderModel: async (providerId: string, canonicalName: string | null): Promise<void> => {
    try {
      await selectProviderModel(createHubTransport(), providerId, canonicalName);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  decisions: async () => {
    try {
      return { decisions: await openDecisions(createHubTransport()) };
    } catch (cause) {
      installerFailure(cause);
    }
  },
  /** Project tenants under the workspace, read straight off the hub -- see `./project-list.ts`. */
  projects: async () => {
    try {
      return { projects: await listProjectSummaries(createHubTransport()) };
    } catch (cause) {
      installerFailure(cause);
    }
  },
  createProject: async (payload: {
    title?: string;
    problemStatement?: string;
    policy: ProjectPolicy;
    delegatedCredentialIds?: string[];
  }) => {
    const problem = payload.problemStatement?.trim() ?? "";
    const title = (payload.title?.trim() || titleFromProblem(problem)).trim();
    if (title.length === 0) {
      throw new ApiFailure({
        code: "validation_failed",
        message: "A project needs a title.",
        correlationId: "-",
        retryable: false,
      });
    }
    try {
      const workspace = await resolveWorkspace(createHubTransport());
      if (!workspace) {
        throw new ApiFailure({
          code: "conflict",
          message: "The workspace is not installed yet.",
          correlationId: "-",
          retryable: false,
          install: true,
        });
      }
      const transport = createHubTransport();
      const status = await request<HostStatus>("/status");
      const { project } = await installerCreateProject(transport, workspace.tenantId, {
        title,
        slug: projectSlug(),
        policy: payload.policy,
        ...(payload.delegatedCredentialIds !== undefined
          ? { delegatedCredentialIds: payload.delegatedCredentialIds }
          : {}),
      });
      const deployment = await installerEnsureLifecycleDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        workspace.tenantId,
        project.id,
      );
      // Fires the deployment's top-level run once: the host no longer
      // launches the lifecycle (`apps/hub/src/lifecycle-run.ts`'s
      // `launchProjectLifecycle` is gone), so a freshly-created project's
      // anchor run is the client's to start. The trigger's own payload is
      // now the project's stage-1 opening statement too (`run-fold.ts`'s
      // `foldOpening` reads it back off the run's `RunStarted` event) — the
      // ledger's separate `project.create`/`POST /projects/:id/open` write
      // is gone (CL-8510); a retried trigger on the same deployment is the
      // workflow runtime's own at-most-once `RunStarted`, so retrying here
      // is safe.
      return await openCreatedProject({
        projectId: project.id,
        open: async () => {
          if (deployment.status !== "current" && deployment.status !== "deployed") {
            return { projectId: project.id, runId: "" };
          }
          await triggerWorkflowRun(transport, workspace.tenantId, deployment.deploymentId, {
            content: JSON.stringify({ projectId: project.id, ...(problem ? { problemStatement: problem } : {}) }),
          });
          return { projectId: project.id, runId: deployment.deploymentId };
        },
        conceal: async (projectId) => {
          await installerUpdateProject(transport, projectId, { deletedAt: new Date() });
        },
        retryable: (cause) => cause instanceof ApiFailure && cause.detail.retryable,
      });
    } catch (cause) {
      installerFailure(cause);
    }
  },
  /** The project's detail, folded client-side — see `./project-view.ts`. Replaces `GET /projects/:id`. */
  projectView: (projectId: string) => loadProjectView(projectId, createHubTransport()).catch((cause: unknown) => { installerFailure(cause); }),
  /** One project, described — folded from the same tenant record and run/artifact folds as `projectView`. */
  projectInfo: (projectId: string): Promise<ProjectInfo> =>
    asWorkspaceOwner(async (transport) => {
      const [project, detail] = await Promise.all([
        installerRequireProject(transport, projectId),
        loadProjectView(projectId, transport),
      ]);
      const live = detail.nodes.filter((node) => node.supersededByNodeId === null);
      const stamps = [...detail.nodes.map((node) => node.createdAt), ...detail.approvals.map((approval) => approval.createdAt)];
      return {
        project: {
          id: project.id,
          title: project.title,
          createdAt: project.createdAt.toISOString(),
          archivedAt: project.archivedAt?.toISOString() ?? null,
        },
        stage: detail.current ? { stage: detail.current.stage, state: detail.current.state } : null,
        // No per-version byte count rides the mounted artifacts module's list
        // metadata (CL-8500 decision 3), so this no longer totals bytes.
        artifacts: { versions: detail.nodes.length, live: live.length, bytes: 0, byKind: [] },
        runs: { total: detail.runs.length, builds: 0 },
        approvals: detail.approvals.length,
        lastActivityAt: stamps.sort().at(-1) ?? project.createdAt.toISOString(),
      };
    }),
  /**
   * Hands files over with the problem; each becomes a `source_material`
   * artifact version the specialists read, written straight to the mounted
   * `@corbits/artifacts` module — no host route left (CL-8510). Unlike the
   * deleted host route, a same-named re-upload always starts a fresh
   * artifact rather than a new version of the same one.
   */
  attachMaterial: (projectId: string, files: File[]) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const attached = await Promise.all(
        files.map(async (file) => {
          const mediaType = file.type || "application/octet-stream";
          const content = mediaType.startsWith("text/") || mediaType === "application/json"
            ? await file.text()
            : `data:${mediaType};base64,${btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))}`;
          const artifact = await installerCreateArtifact(transport, workspaceTenantId, {
            title: file.name,
            content,
            metadata: {
              sb: {
                projectId,
                kind: MATERIAL_KIND,
                stage: 1,
                variant: file.name,
                sourceVersionIds: [],
                provenance: { producer: "human" as const },
                mediaType,
              },
            },
          });
          return { nodeId: artifact.id, name: file.name, mediaType, sizeBytes: file.size };
        }),
      );
      return { attached };
    }),
  /** The stakeholders stage 5 writes for, and the roles one may hold — read off the hub tenant directly. */
  stakeholders: (projectId: string) =>
    asWorkspaceOwner(async (transport) => {
      const project = await installerRequireProject(transport, projectId);
      return {
        audiences: project.policy.audiences,
        audienceQuorum: project.policy.audienceQuorum,
        roles: [...STAKEHOLDER_ROLES],
      };
    }),
  setStakeholders: (projectId: string, payload: { audiences: { name: string; role: string }[]; audienceQuorum: number }) =>
    asWorkspaceOwner(async (transport) => {
      const current = await installerRequireProject(transport, projectId);
      const policy = stakeholdersPolicy(current.policy, payload);
      const updated = await installerUpdateProject(transport, projectId, { policy });
      await installProjectAuthority(transport, projectId, updated.policy);
      return {
        audiences: updated.policy.audiences,
        audienceQuorum: updated.policy.audienceQuorum,
        roles: [...STAKEHOLDER_ROLES],
      };
    }),
  updateProject: (projectId: string, payload: { title?: string; archived?: boolean }) =>
    asWorkspaceOwner(async (transport) => {
      const title = payload.title?.trim();
      if (title !== undefined && title.length === 0) {
        throw new ApiFailure({
          code: "validation_failed",
          message: "A project needs a name.",
          correlationId: "-",
          retryable: false,
        });
      }
      await installerUpdateProject(transport, projectId, {
        ...(title !== undefined ? { title: title.slice(0, 120) } : {}),
        ...(typeof payload.archived === "boolean" ? { archivedAt: payload.archived ? new Date() : null } : {}),
      });
      return { ok: true as const };
    }),
  deleteProject: (projectId: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      await revokeAllDelegations(liveDelegationStore(transport, workspaceTenantId), projectId);
      await installerUpdateProject(transport, projectId, { deletedAt: new Date() });
      return { ok: true as const };
    }),
  /** The workspace tenant artifacts are recorded under; resolved once and threaded down as a prop. */
  workspaceTenantId: () => resolveWorkspace(createHubTransport()).then((workspace) => workspace?.tenantId ?? null),
  /** An artifact's current content, over the mounted `@corbits/artifacts` module — no host route left. */
  artifactContent: async (tenantId: string, nodeId: string): Promise<{ content: string }> => {
    const artifact = await installerGetArtifact(createHubTransport(), tenantId, nodeId);
    return { content: artifact?.content ?? "" };
  },
  /** Saves a package's already-recorded slides into the Downloads folder; says where. The host does not build them. */
  saveSlidesFor: (packageNodeId: string) =>
    post<{ path: string; bytes: number; nodeId: string }>(`/artifacts/${packageNodeId}/slides/save`, {}),
  /** Where a design is served as a page of its own, for printing. A path, not a request. */
  printPage: (nodeId: string) => `/api/artifacts/${nodeId}/print`,
  preferences: () => request<{ preferences: Record<string, unknown> }>("/preferences"),
  setPreference: (key: string, value: unknown) =>
    request<{ key: string }>(`/preferences/${key}`, {
      method: "PUT",
      body: JSON.stringify(value),
    }),
  designerSettings: () => loadDesignerSettings(createHubTransport()),
  saveDesignerSetting: <K extends keyof DesignerSettings>(key: K, value: DesignerSettings[K]) =>
    saveDesignerSettings(createHubTransport(), { [key]: value } as Partial<DesignerSettings>).catch((cause) => {
      installerFailure(cause);
    }),
  /**
   * The metadata-folded artifact graph — CL-8500 decision 3. Client-side
   * only: lists the tenant's artifacts over the mounted `@corbits/artifacts`
   * module and folds them to one project, no host route involved. Replaces
   * `GET /projects/:id/graph` (CL-8510); nodes come back in the same
   * `ArtifactNode` shape `projectView`'s `nodes` already use.
   */
  artifactGraph: (projectId: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const graph = await artifactGraphFor(transport, workspaceTenantId, projectId);
      return { nodes: graph.nodes.map(toArtifactNode), edges: graph.edges };
    }),
  stopHost: () => post<{ stopping: boolean }>("/host/stop"),
};
