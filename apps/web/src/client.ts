/**
 * The API client.
 *
 * The one place the interface talks to the host. Every call goes through
 * `request`, so an error contract change is a change here and nowhere else.
 * Clients read and command; they never write persistence.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-prompt";
import {
  ApiError as HubApiError,
  createProject as installerCreateProject,
  ensureLifecycleDeployment as installerEnsureLifecycleDeployment,
  install as installerInstall,
  installState as installerInstallState,
  installProjectAuthority,
  InstallerError,
  liveDelegationStore,
  ensureRegistryTarballs,
  requireProject as installerRequireProject,
  resolveWorkspace,
  revokeAllDelegations,
  updateProject as installerUpdateProject,
  type ClosureManifest,
  type InstallState as PackageInstallState,
  type ProjectPolicy,
  type RegistryTarballUploader,
  type SidecarCapability,
} from "@solutions-builder/installer";
import { openCreatedProject } from "./create-project-open.ts";
import { createHubTransport } from "./hub.ts";
import { listProjectSummaries } from "./project-list.ts";
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

/** A multipart post: the browser sets the content type, boundary and all. */
async function requestForm<T>(path: string, form: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: "POST", body: form });
  } catch {
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
      detail ?? { code: "internal_error", message: `The host answered ${response.status}.`, correlationId: "-", retryable: false },
    );
  }
  return body as T;
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
  inference: { connected: boolean; active: string | null };
  canPlaceSidecars: boolean;
  sidecarFingerprint: string | null;
  hub: {
    mode: "embedded" | "remote";
    url: string | null;
    ready: boolean;
    detail: string;
    reported: { status?: string } | null;
  };
  build: {
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
    /** §6's expected mutable revision, sent with every decision. */
    revision: number;
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
  waits: Wait[];
  flags: { id: string; trigger: string; classification: string; evidence: unknown; chosenRoute: number | null; createdAt: string }[];
  questions: { id: string; prompt: string; answeredAt: string | null; answer: string | null }[];
  manifests: { id: string; manifestHash: string; acceptedAt: string | null; descriptors: unknown }[];
  /**
   * The stage-1 opening problem statement, off the `project.create` command —
   * ledger data the stage-thread fold cannot read out of `/hub` events.
   */
  opening: { body: string; createdAt: string } | null;
  /** Turns carried in from another instance on import, by stage — ledger data, same reason. */
  carriedTurns: { stage: number; turn: StageTurn }[];
};

export type DesignAnchor = {
  testId?: string;
  domPath?: string;
  role?: string;
  textFingerprint?: string;
};

export type DesignFeedback = {
  id: string;
  designNodeId: string;
  direction: "choose" | "combine" | "revise" | "reject";
  overallNote: string;
  submittedAt: string;
  promptHash: string;
  comments: {
    id: string;
    anchor: DesignAnchor;
    body: string;
    author: string;
    disposition: "open" | "addressed" | "declined" | "superseded";
  }[];
};

export type CommandOutcome = {
  runId: string;
  stage: number;
  state: string;
  transitionId: string;
  replayed: boolean;
  waitId?: string;
};

/** Orientation from the Product guide, or the deterministic checklist. */
export type Guidance = {
  summary: string;
  readiness: "ready" | "not_ready" | "blocked";
  missing: string[];
  options: { label: string; detail: string }[];
  recommended: string;
  questions: string[];
  sourceVersionIds: string[];
  origin: "agent" | "deterministic";
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
 * fail `install()` — the source-tree deploy arm still works either way until
 * the tarball arm is switched on (CL-8334).
 */
async function ensureClosureRegistryAsset(tenantId: string): Promise<void> {
  try {
    const response = await fetch("/closure/manifest.json", { credentials: "same-origin" });
    if (!response.ok) return;
    const manifest = (await response.json()) as ClosureManifest;
    await ensureRegistryTarballs(
      createHubTransport(),
      tenantId,
      hubTarballUploaderFor(tenantId),
      manifest,
      async (filename) => {
        const tarball = await fetch(`/closure/${filename}`, { credentials: "same-origin" });
        if (!tarball.ok) throw new Error(`could not fetch closure tarball ${filename}`);
        return new Uint8Array(await tarball.arrayBuffer());
      },
    );
  } catch (cause) {
    // Best effort: the source-tree deploy arm is still what `createProject`
    // relies on until CL-8334 switches it.
    console.warn("ensureClosureRegistryAsset failed", cause);
  }
}

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
      const state = await installerInstall(createHubTransport(), sidecarCapabilityOf(status), {
        afterSkillAssets: rerankCatalogAfterSkillAssets,
      });
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
  decisions: () => request<{ decisions: Wait[] }>("/decisions"),
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
      await installerEnsureLifecycleDeployment(
        transport,
        sidecarCapabilityOf(status),
        workspace.tenantId,
        project.id,
      );
      const body = problem.length > 0 ? { problemStatement: problem } : {};
      return await openCreatedProject({
        projectId: project.id,
        open: () => post<{ projectId: string; runId: string }>(`/projects/${project.id}/open`, body),
        conceal: async (projectId) => {
          await installerUpdateProject(transport, projectId, { deletedAt: new Date() });
        },
        retryable: (cause) => cause instanceof ApiFailure && cause.detail.retryable,
      });
    } catch (cause) {
      installerFailure(cause);
    }
  },
  project: (projectId: string) => request<ProjectDetail>(`/projects/${projectId}`),
  projectInfo: (projectId: string) => request<ProjectInfo>(`/projects/${projectId}/info`),
  /** Writes the project's export beside the person's downloads and says where. */
  exportProject: (projectId: string) =>
    post<{ path: string; bytes: number; nodes: number; commands: number }>(`/projects/${projectId}/export`, {}),
  /** Hands files over with the problem; each becomes a version the specialists read. */
  attachMaterial: (projectId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    return requestForm<{ attached: { nodeId: string; name: string; mediaType: string; sizeBytes: number }[] }>(
      `/projects/${projectId}/material`,
      form,
    );
  },
  /** Brings an exported project in as a new project here. */
  importProject: (bundle: unknown) =>
    post<{ projectId: string; nodes: number; commands: number }>("/projects/import", bundle),
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
  artifact: (nodeId: string) =>
    request<{ node: ArtifactNode; content: string }>(`/artifacts/${nodeId}`),
  /** Exactly what the specialists are handed for an attached file. */
  materialReading: (nodeId: string) => request<{ text: string }>(`/artifacts/${nodeId}/reading`),
  /** Saves a package's already-recorded slides into the Downloads folder; says where. The host does not build them. */
  saveSlidesFor: (packageNodeId: string) =>
    post<{ path: string; bytes: number; nodeId: string }>(`/artifacts/${packageNodeId}/slides/save`, {}),
  /** Saves an artifact that is a file (a stakeholder's slides) into the Downloads folder; says where. */
  saveArtifactFile: (nodeId: string) => post<{ path: string; bytes: number }>(`/artifacts/${nodeId}/save`, {}),
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
  guidance: (projectId: string) =>
    request<{ guidance: Guidance }>(`/projects/${projectId}/guidance`),
  /**
   * A host effect (a frozen packet, a build attempt, a route selection). A
   * gate decision is not one: it is a named signal on the run (`run-signal.ts`).
   */
  command: (projectId: string, command: string, payload: unknown) =>
    post<CommandOutcome>(`/projects/${projectId}/commands/${command}`, payload),
  buildEvents: (projectId: string) =>
    request<{ events: BuildEvent[] }>(`/projects/${projectId}/build/events`),
  design: (projectId: string) =>
    request<{
      designs: ArtifactNode[];
      feedback: {
        designNodeId: string;
        feedback?: DesignFeedback;
        prompt?: string;
      }[];
    }>(`/projects/${projectId}/design`),
  submitFeedback: (projectId: string, payload: unknown) =>
    post<{ feedback: DesignFeedback; prompt: string; feedbackNodeId: string }>(
      `/projects/${projectId}/design/feedback`,
      payload,
    ),
  graph: (projectId: string) =>
    request<{
      nodes: ArtifactNode[];
      edges: { childNodeId: string; sourceNodeId: string }[];
    }>(`/projects/${projectId}/graph`),
  stopHost: () => post<{ stopping: boolean }>("/host/stop"),
};
