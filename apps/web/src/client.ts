/**
 * The API client.
 *
 * The one place the interface talks to the host. Every call goes through
 * `request`, so an error contract change is a change here and nowhere else.
 * Clients read and command; they never write persistence.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { AUTHORITIES, type Authority, type Stage } from "@solutions-builder/app/ledger";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-prompt";
import {
  ApiError as HubApiError,
  createArtifact as installerCreateArtifact,
  createProject as installerCreateProject,
  ensureSpecialistDeployment,
  getArtifact as installerGetArtifact,
  reviseArtifact as installerReviseArtifact,
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
  stageSpecialistStatus,
  updateProject as installerUpdateProject,
  type ClosureManifest,
  type ClosureSource,
  type InstallState as PackageInstallState,
  type ProjectPolicy,
  type RegistryTarballUploader,
  type SidecarCapability,
  type SpecialistDeployment,
  type SpecialistDeploymentStatus,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import { MATERIAL_KIND } from "@solutions-builder/app/artifacts";

/**
 * The document kind a stage's own approved draft is recorded under, once a
 * person approves it. The workflow itself never writes a stage artifact
 * (only `attachMaterial` writes one, for a person's own upload): the
 * mail-chat specialist's reply is the draft, held only in the mailbox, until
 * approval turns it into the stage's document of record.
 */
/**
 * The `source_material` variant a project's own opening problem statement is
 * stamped under, at create time — the mail-agent contract (CL-8612) has no
 * lifecycle run whose `RunStarted` trigger payload could carry it, so it is
 * written the same way any other attached material is, and `projectOpening`
 * reads it back by this marker.
 */
const OPENING_VARIANT = "__opening__";

export const STAGE_DRAFT_KIND: Readonly<Record<number, string>> = {
  1: "problem_brief",
  2: "solution_constraints",
  3: "chosen_approach",
  4: "design_artifact",
  5: "audience_package",
  6: "build_plan",
  7: "cost_approval",
  8: "build_evidence",
  9: "delivery_manifest",
};
import { artifactGraphFor } from "./artifact-graph.ts";
import { openCreatedProject } from "./create-project-open.ts";
import { createHubTransport } from "./hub.ts";
import {
  readStageThread as readStageThreadViaHub,
  sendStageMail as sendStageMailViaHub,
  type ChatMessage,
} from "./stage-mail.ts";
import { hubCredentials, hubOrigin } from "./hub-origin.ts";
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
  /** The HTTP status the host answered with, when the failure came from a response (not a dropped connection). */
  readonly httpStatus: number | undefined;
  constructor(detail: ApiError, httpStatus?: number) {
    super(detail.message);
    this.name = "ApiFailure";
    this.detail = detail;
    this.httpStatus = httpStatus;
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
    // `response.status` rides along regardless of whether the host sent a
    // structured error body: a 401 with no session cookie has nothing to
    // parse, but the caller still needs to tell "not signed in" apart from
    // "the host is unreachable".
    throw new ApiFailure(
      detail ?? {
        code: "internal_error",
        message: `The host answered ${response.status}.`,
        correlationId: "-",
        retryable: false,
      },
      response.status,
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
  /**
   * Set only for stage 9's delivery gate: a stock hub approval on the
   * specialist's own `deliver` tool call, not a workflow signal (CL-8566).
   * Its presence is what tells `decide()` to resolve it through the
   * approval routes instead of `deliverGate`.
   */
  approvalId?: string;
};

export type ProjectSummary = {
  id: string;
  revision: number;
  title: string;
  /** 1 + the highest stage with a live, approved draft artifact — the same cursor `pages/workspace/index.tsx` derives per-project. */
  stage: number | null;
  archivedAt: string | null;
  /** A stock hub approval (stage 9's delivery) is pending on this project. */
  needsDecision: boolean;
  waits: Wait[];
  /** Whether the specialist is drafting or the person's move — no gate, no signal, just "is there an unapproved reply." */
  turn: "writing" | "idle";
};

export type ProjectInfo = {
  project: { id: string; title: string; createdAt: string; archivedAt: string | null };
  stage: number | null;
  artifacts: { versions: number; live: number; bytes: number; byKind: { kind: string; count: number; bytes: number }[] };
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
  /** `sb.approvedAt`, stamped only by `persistStageDraft` (the Approve path) — null for any other write of this kind (CL-8639). */
  approvedAt: string | null;
};

/**
 * A stage-4 note recorded against a design node, folded from the node's own
 * artifact metadata (`metadata.sb.feedback`) — CL-8620. There is no lifecycle
 * run to fold this from any more (CL-8612 contract v6): the artifact record
 * is the whole history.
 */
export type DesignFeedbackEntry = { nodeId: string; text: string; at: string };

export type ProjectDetail = {
  project: {
    id: string;
    title: string;
    policy: unknown;
    archivedAt: string | null;
  };
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  /** 1 + the highest stage with a live, approved draft artifact — no lifecycle run to fold a position from any more (CL-8612). */
  stage: number;
  /** True when no principal other than the local actor holds this stage's approval authority. */
  soloApproval: boolean;
  nodes: ArtifactNode[];
  /**
   * Always empty now: recorded approvals rode the lifecycle run's own event
   * fold (`./run-fold.ts`'s `projectApprovals`, deleted with the run —
   * CL-8612 contract v6). `ApprovalsRecord` (`pages/workspace/gate.tsx`)
   * renders nothing on an empty list, so the historical-record surface just
   * has nothing to show until a mail-agent-shaped decision log replaces it.
   */
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
};

/**
 * One stakeholder's own proceed/revise/reject on a stage-5 package,
 * appended to that package artifact's `sb.decisions` — no lifecycle run to
 * park a decision on any more (CL-8612 contract v6; CL-8625).
 */
export type AudienceDecision = {
  audience: string;
  decision: "proceed" | "revise" | "reject";
  note: string;
  at: string;
  by: string;
};

export type { Quote, StageTurn };

/** The stage-1 brief evaluator's verdict. Advisory only — nothing gates on it. */
export type Evaluation = { ready: boolean; notes: string[] };

export type InstallState = PackageInstallState;

const HOSTED_INSTALL: InstallState = {
  installed: true,
  appVersion: APP_VERSION,
  detail: "Hosted hub: managed there.",
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

export function sidecarCapabilityOf(status: Pick<HostStatus, "canPlaceSidecars">): SidecarCapability {
  return { canPlaceSidecars: status.canPlaceSidecars };
}

/**
 * A `RegistryTarballUploader` over the hub's own origin, for one tenant
 * scope. `createHubTransport`'s `Transport.fetch` always JSON-encodes its
 * body, so the tarball's raw bytes are PUT with a plain `fetch` instead, the
 * same hub route the rest of the browser client calls directly, with no
 * relay in between.
 */
function hubTarballUploaderFor(scope: string): RegistryTarballUploader {
  return {
    async putTarball(assetId, filename, bytes) {
      const response = await fetch(
        `${hubOrigin()}/api/tenants/${encodeURIComponent(scope)}/assets/${assetId}/tarballs/${filename}`,
        {
          method: "PUT",
          credentials: hubCredentials(),
          body: new Uint8Array(bytes),
        },
      );
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
 * browser speaks the pack, this file only supplies the same-origin-
 * credentialed URL `pushSourceTree` cannot construct itself.
 */
const lifecycleGitPush: WorkflowGitPush = ({ scope, assetKind, assetName, token, tree, message }) => {
  const base = hubOrigin() || window.location.origin;
  const url = new URL(
    `/api/tenants/${encodeURIComponent(scope)}/assets/${assetKind}/${assetName}.git`,
    base,
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

/** In-flight/resolved `ensureStageAgent` calls, keyed `${projectId}:${stage}` --
 *  see that method's doc comment. */
const ensureStageAgentCalls = new Map<string, Promise<SpecialistDeployment>>();

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

/** `sb.decisions` off a package artifact's metadata, or empty if none are recorded yet. */
function readAudienceDecisions(metadata: Record<string, unknown> | null): AudienceDecision[] {
  const sb = (metadata as { sb?: Record<string, unknown> } | null)?.sb;
  const decisions = sb?.decisions;
  return Array.isArray(decisions) ? (decisions as AudienceDecision[]) : [];
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
      const state = await installerInstall(createHubTransport(), { afterSkillAssets: rerankCatalogAfterSkillAssets });
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
      const { project } = await installerCreateProject(transport, workspace.tenantId, {
        title,
        slug: projectSlug(),
        policy: payload.policy,
        ...(payload.delegatedCredentialIds !== undefined
          ? { delegatedCredentialIds: payload.delegatedCredentialIds }
          : {}),
      });
      // No lifecycle run to deploy or trigger any more (CL-8612 contract
      // v6): a stage's specialist deploys lazily the first time its panel
      // opens (`ensureStageAgent`). The opening problem statement is
      // written straight to the workspace tenant's own artifact store, the
      // same way `attachMaterial` writes any other material, so
      // `projectOpening` can read it back with no run to fold.
      return await openCreatedProject({
        projectId: project.id,
        open: async () => {
          if (problem) {
            await installerCreateArtifact(transport, workspace.tenantId, {
              title: "Opening problem statement",
              content: problem,
              metadata: {
                sb: {
                  projectId: project.id,
                  kind: MATERIAL_KIND,
                  stage: 1,
                  variant: OPENING_VARIANT,
                  sourceVersionIds: [],
                  provenance: { producer: "human" as const },
                  mediaType: "text/plain",
                },
              },
            });
          }
          return { projectId: project.id, runId: "" };
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
      const stamps = detail.nodes.map((node) => node.createdAt);
      return {
        project: {
          id: project.id,
          title: project.title,
          createdAt: project.createdAt.toISOString(),
          archivedAt: project.archivedAt?.toISOString() ?? null,
        },
        stage: detail.stage,
        // No per-version byte count rides the mounted artifacts module's list
        // metadata (CL-8500 decision 3), so this no longer totals bytes.
        artifacts: { versions: detail.nodes.length, live: live.length, bytes: 0, byKind: [] },
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
  /**
   * Persists the mail-chat specialist's approved reply as the stage's own
   * document, written the same way `attachMaterial` writes straight to the
   * mounted `@corbits/artifacts` module. Called once, right before the
   * approval signal, so the run's own gate always names a real version.
   */
  persistStageDraft: (
    projectId: string,
    stage: number,
    content: string,
    sourceVersionIds: string[] = [],
    /** Stage 7 only: the target chosen at freeze time, recorded as `sb.target`. */
    target?: string,
  ) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const kind = STAGE_DRAFT_KIND[stage];
      if (!kind) {
        throw new ApiFailure({
          code: "validation_failed",
          message: `Stage ${stage} has no draft document to approve.`,
          correlationId: "-",
          retryable: false,
        });
      }
      const artifact = await installerCreateArtifact(transport, workspaceTenantId, {
        title: `Stage ${stage} draft`,
        content,
        metadata: {
          sb: {
            projectId,
            kind,
            stage,
            mediaType: "text/markdown",
            sourceVersionIds,
            provenance: { producer: "agent" as const },
            // Only the explicit Approve path stamps this; the stage cursor
            // (`currentStageFromArtifacts`) advances on it, never on a
            // draft/package/decision write merely existing (CL-8639).
            approvedAt: new Date().toISOString(),
            ...(target ? { target } : {}),
          },
        },
      });
      // Same convention `toArtifactNode` (`project-view.ts`) reads back: the
      // module revises an artifact in place, so its own id doubles as the
      // version id, and `<id>@<version>` stands in for a content hash.
      return {
        artifactId: artifact.id,
        versionId: artifact.id,
        contentHash: `${artifact.id}@${String(artifact.version)}`,
      };
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
  /** The decisions already recorded on a stage-5 package artifact's `sb.decisions`, oldest first. */
  audienceDecisions: async (tenantId: string, packageNodeId: string): Promise<{ decisions: AudienceDecision[] }> => {
    const artifact = await installerGetArtifact(createHubTransport(), tenantId, packageNodeId);
    return { decisions: readAudienceDecisions(artifact?.metadata ?? null) };
  },
  /**
   * Records one stakeholder's own proceed/revise/reject on their package,
   * by revising that package artifact's `sb` metadata — the mail-agent-shaped
   * replacement for the deleted lifecycle-run `audience.decide` (CL-8625).
   * Title and content carry forward unchanged; only `sb.decisions` grows.
   */
  recordAudienceDecision: async (
    tenantId: string,
    packageNodeId: string,
    input: { audience: string; decision: AudienceDecision["decision"]; note: string },
  ): Promise<{ decisions: AudienceDecision[] }> => {
    const transport = createHubTransport();
    const artifact = await installerGetArtifact(transport, tenantId, packageNodeId);
    const sb = (artifact?.metadata as { sb?: Record<string, unknown> } | null)?.sb ?? {};
    const decisions = [
      ...readAudienceDecisions(artifact?.metadata ?? null),
      {
        audience: input.audience,
        decision: input.decision,
        note: input.note.trim(),
        at: new Date().toISOString(),
        by: input.audience,
      },
    ];
    await installerReviseArtifact(transport, tenantId, packageNodeId, {
      metadata: { sb: { ...sb, decisions } },
    });
    return { decisions };
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
  sendStageMail: async (
    tenantId: string,
    agentAddress: string,
    input: { body: string; subject?: string; inReplyTo?: string },
  ): Promise<void> => {
    try {
      await sendStageMailViaHub(tenantId, agentAddress, input);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  readStageThread: async (tenantId: string, agentAddresses: string[]): Promise<ChatMessage[]> => {
    try {
      return await readStageThreadViaHub(tenantId, agentAddresses);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  /**
   * Makes sure `projectId`'s stage-`stage` specialist is deployed, the same
   * transport/sidecar/closure/gitPush plumbing `createProject` uses for the
   * lifecycle deployment above, and hands back its mail address. Deploys
   * lazily, once per stage per project (`ensureSpecialistDeployment` itself
   * is idempotent against a live deployment on the same asset).
   *
   * Memoised per `projectId:stage`: React can mount this call from two
   * places at once (header + panel, an effect double-run), and each would
   * otherwise see no deployment yet and race to create one. Callers share
   * the one in-flight promise instead; a rejection clears the entry so a
   * retry can try again.
   *
   * A memoised deployment can still go stale (CL-8654): two sessions racing
   * to open the same stage each deploy, the hub releases the loser, and a
   * session that memoised the loser's address would mail into the void
   * forever. Every resolution is re-checked against `stageAgentStatus`; when
   * a different deployment is now the live pick, the memo is dropped and the
   * fresh one deployed/returned instead.
   */
  ensureStageAgent: (projectId: string, stage: number): Promise<SpecialistDeployment> => {
    const key = `${projectId}:${stage}`;
    const pending = ensureStageAgentCalls.get(key);
    if (pending) {
      return pending.then(async (deployment) => {
        const fresh = await api.stageAgentStatus(projectId, stage).catch(() => null);
        if (fresh && fresh.deploymentId !== deployment.deploymentId) {
          ensureStageAgentCalls.delete(key);
          return api.ensureStageAgent(projectId, stage);
        }
        return deployment;
      });
    }
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await request<HostStatus>("/status");
      return ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        workspaceTenantId,
        projectId,
        stage as Stage,
      );
    });
    call.catch(() => ensureStageAgentCalls.delete(key));
    ensureStageAgentCalls.set(key, call);
    return call;
  },
  /**
   * Re-lists `projectId`'s stage-`stage` specialist deployment without
   * deploying anything -- the live pick `ensureStageAgent` would resolve to
   * right now. Used to detect a memoised `agentAddress` going stale (CL-8654)
   * from outside `ensureStageAgent`'s own memo, e.g. a workspace already
   * holding an address polling for whether it is still the live one.
   */
  stageAgentStatus: (projectId: string, stage: number): Promise<SpecialistDeploymentStatus | null> =>
    asWorkspaceOwner((transport, workspaceTenantId) =>
      stageSpecialistStatus(transport, workspaceTenantId, projectId, stage as Stage),
    ),
  /**
   * The project's opening problem statement, read off the `source_material`
   * artifact `createProject` wrote for it — no lifecycle run to fold it from
   * any more (CL-8612 contract v6). Answers null once there is nothing to
   * open on: the project was created with no problem statement.
   */
  projectOpening: (projectId: string): Promise<{ body: string; createdAt: string } | null> =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const graph = await artifactGraphFor(transport, workspaceTenantId, projectId);
      const node = graph.nodes.find((entry) => entry.kind === MATERIAL_KIND && entry.variant === OPENING_VARIANT);
      if (!node) return null;
      const artifact = await installerGetArtifact(transport, workspaceTenantId, node.id);
      if (!artifact) return null;
      return { body: artifact.content, createdAt: node.createdAt };
    }),
  /**
   * The feedback recorded on one design node — read straight off its own
   * artifact's `metadata.sb.feedback` (CL-8620), no lifecycle run to fold
   * from any more. Empty for a node that has never had feedback recorded,
   * or that is not a persisted artifact yet (a not-yet-approved reply).
   */
  designFeedback: async (tenantId: string, nodeId: string): Promise<DesignFeedbackEntry[]> => {
    const artifact = await installerGetArtifact(createHubTransport(), tenantId, nodeId).catch(() => null);
    const sb = (artifact?.metadata as { sb?: { feedback?: unknown } } | null)?.sb;
    return Array.isArray(sb?.feedback) ? (sb.feedback as DesignFeedbackEntry[]) : [];
  },
  /**
   * Persists a stage-5 specialist reply as one named audience's package
   * artifact (CL-8636): "Write it" sends the mail, but nothing else turns
   * the mail-agent's reply into the artifact the packages list reads, so it
   * never left "No packages yet". Written the same way `persistStageDraft`
   * writes a stage's own draft, stamped with `variant` so it is that
   * audience's package rather than the stage's single document.
   */
  persistAudiencePackage: (projectId: string, audience: string, content: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const artifact = await installerCreateArtifact(transport, workspaceTenantId, {
        title: `${audience}'s package`,
        content,
        metadata: {
          sb: {
            projectId,
            kind: STAGE_DRAFT_KIND[5]!,
            stage: 5,
            variant: audience,
            mediaType: "text/markdown",
            sourceVersionIds: [],
            provenance: { producer: "agent" as const },
          },
        },
      });
      return {
        artifactId: artifact.id,
        versionId: artifact.id,
        contentHash: `${artifact.id}@${String(artifact.version)}`,
      };
    }),
  /**
   * Attaches feedback to a design node: mails the stage 4 specialist so it
   * lands in its next turn, and records it on the node's own artifact
   * metadata (`sb.feedback`) via `reviseArtifact` so it survives to fold back
   * into `feedbackByNode` on reload — CL-8620. The specialist's mail address
   * comes from `ensureStageAgent`, deployed lazily the same way the
   * workspace's own composer resolves it. The node's project id rides its
   * own `sb.projectId` (every stage draft is written with one), so this
   * needs nothing beyond the node itself.
   */
  submitDesignFeedback: (tenantId: string, node: { id: string; title: string }, text: string) =>
    asWorkspaceOwner(async (transport) => {
      const artifact = await installerGetArtifact(transport, tenantId, node.id).catch(() => null);
      const sb = (artifact?.metadata as { sb?: Record<string, unknown> } | null)?.sb ?? {};
      const projectId = typeof sb.projectId === "string" ? sb.projectId : null;
      if (!projectId) {
        throw new ApiFailure({
          code: "validation_failed",
          message: "This design has not been saved yet — approve a version before leaving feedback on it.",
          correlationId: "-",
          retryable: false,
        });
      }
      const existing = Array.isArray(sb.feedback) ? (sb.feedback as DesignFeedbackEntry[]) : [];
      const entry: DesignFeedbackEntry = { nodeId: node.id, text, at: new Date().toISOString() };
      const deployment = await api.ensureStageAgent(projectId, 4);
      await Promise.all([
        api.sendStageMail(tenantId, deployment.address, { body: `Feedback on ${node.title}: ${text}` }),
        installerReviseArtifact(transport, tenantId, node.id, {
          metadata: { sb: { ...sb, feedback: [...existing, entry] } },
        }),
      ]);
    }),
};
