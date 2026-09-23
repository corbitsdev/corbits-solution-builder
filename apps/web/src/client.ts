/**
 * The API client.
 *
 * The one place the interface talks to the host. Every call goes through
 * `request`, so an error contract change is a change here and nowhere else.
 * Clients read and command; they never write persistence.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { AUTHORITIES, type Authority, type Stage } from "@solutions-builder/app/ledger";
import { agentById, panelPrincipals, type AgentRole } from "@solutions-builder/app/kit";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-prompt";
import {
  ApiError as HubApiError,
  archiveArtifact as installerArchiveArtifact,
  createArtifact as installerCreateArtifact,
  createProject as installerCreateProject,
  ensureProjectWorkflow,
  ensureSpecialistDeployment,
  waitForDeploymentDeployed,
  getArtifact as installerGetArtifact,
  reviseArtifact as installerReviseArtifact,
  install as installerInstall,
  installState as installerInstallState,
  installProjectAuthority,
  InstallerError,
  liveDelegationStore,
  listArtifacts,
  listSpecialistDeployments,
  ensureRegistryTarballs,
  pushSourceTree,
  requireProject as installerRequireProject,
  resolveWorkspace,
  revokeAllDelegations,
  stageSpecialistStatus,
  updateProject as installerUpdateProject,
  vendoredMemberFiles,
  workflowsFor,
  type ClosureManifest,
  type ClosureSource,
  type InstallState as PackageInstallState,
  type ProjectPolicy,
  type ProjectWorkflowDeployment,
  type ProjectWorkflowStageInput,
  type RegistryTarballUploader,
  type SidecarCapability,
  type SpecialistDeployment,
  type SpecialistDeploymentStatus,
  type WorkflowGitPush,
} from "@solutions-builder/installer";
import { loadProjectWorkflowView, type ProjectWorkflowView } from "./project-workflow.ts";
import { cacheProjectWorkflowRef, resolveProjectWorkflowRef } from "./project-workflow-ref.ts";
import { parseBundle } from "./project-export.ts";
import { importProject as importProjectBundle } from "./project-import.ts";
import { MATERIAL_KIND, MATERIAL_READING_KIND } from "@solutions-builder/app/artifacts";
import { readMaterial } from "./material-reading.ts";
import type { DesignFeedbackDisposition, DesignFeedbackEntry as DesignFeedbackGraphEntry } from "@solutions-builder/app/artifact-graph";
import type { TemplateTheme } from "@solutions-builder/app/deck";
import { withDisposition } from "./design-disposition.ts";
import {
  DECK_SETTINGS_KIND,
  DECK_SETTINGS_TITLE,
  DECK_TEMPLATE_KIND,
  deckSettingsContent,
  parseDeckSettings,
  readTemplateTheme,
  withRoleTemplate,
  type DeckSettings,
} from "./deck-templates.ts";

/**
 * The document kind a stage's own approved draft is recorded under, once a
 * person approves it. The workflow itself never writes a stage artifact
 * (only `attachMaterial` writes one, for a person's own upload): the
 * mail-chat specialist's reply is the draft, held only in the mailbox, until
 * approval turns it into the stage's document of record.
 */
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
import { toBase64 } from "./base64.ts";
import { openCreatedProject } from "./create-project-open.ts";
import { createHubTransport } from "./hub.ts";
import {
  readStageThread as readStageThreadViaHub,
  sendStageMail as sendStageMailViaHub,
  type ChatMessage,
} from "./stage-mail.ts";
import {
  parseWithdrawnTurns,
  withdrawnTurnsContent,
  WITHDRAWN_TURNS_KIND,
  type WithdrawnMark,
} from "./withdrawn-turns.ts";
import { hubCredentials, hubOrigin } from "./hub-origin.ts";
import { listProjectSummaries, OPENING_VARIANT } from "./project-list.ts";
import { openDecisions } from "./decisions-fold.ts";
import { loadProjectView, toArtifactNode } from "./project-view.ts";
import { projectUsage, type ProjectUsage, type WorkspaceSpend } from "./project-usage.ts";
import { designerSettings as loadDesignerSettings, saveDesignerSettings, type DesignerSettings } from "./designer-settings.ts";
import { deckDesigns as loadDeckDesigns, saveDeckDesignPreference } from "./deck-design-settings.ts";
import {
  API_KEY_CONNECT_OPTIONS,
  OAUTH_CONNECT_OPTIONS,
  connectApiKeyProvider,
  connectLocalProvider,
  connectOAuthProvider,
  disconnectProvider,
  listConnectedProviders,
  listResolvedCatalog,
  makeResolvedDefault,
  moveResolvedModel,
  refreshProviderModels,
  resolveActiveModel,
  rerankCatalogViaHub,
  reorderProviders,
  selectProviderModel,
  setResolvedRestricted,
  setResolvedShadowed,
  type ActiveModel,
  type ModelMoveDirection,
  type ResolvedCatalogRow,
} from "./provider-catalog.ts";

export type { ActiveModel, ResolvedCatalogRow } from "./provider-catalog.ts";

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
  /** Workspace data directory this host is using. From `dataDirectory()` on the host. */
  dataDir?: string;
  canPlaceSidecars: boolean;
  sidecarFingerprint: string | null;
  hub: {
    mode: "embedded" | "remote";
    url: string | null;
    ready: boolean;
    detail: string;
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
  /** The tool name `approvalId` was raised for, e.g. "run_shell" or "deliver" — lets the queue offer "Allow for this build" only where a standing grant makes sense. */
  toolName?: string;
  /**
   * Set on every stage-approval wait (no `approvalId`): the project
   * workflow's own open review at this stage — the only thing that raises
   * one. Its exact reference is what lets the queue approve directly
   * (CL-8724).
   */
  reviewRef?: { artifactId: string; version: number; sha256: string };
  /** When the person was notified of this decision, or the error kept while filing the decision if notifying failed (CL-8724). Neither set means "not sent yet". */
  notifiedAt?: string;
  notifyError?: string;
};

export type ProjectSummary = {
  id: string;
  revision: number;
  title: string;
  /** First non-empty line of the stored opening problem, or null when none was written. */
  description: string | null;
  /** Always null off `listProjectSummaries` -- `project-list.ts`'s `displayStage` reads the project workflow's own stage per card, or null when it could not be read. */
  stage: number | null;
  archivedAt: string | null;
  /** A stock hub approval (stage 9's delivery) is pending on this project. */
  needsDecision: boolean;
  waits: Wait[];
  /** Whether the specialist is drafting or the person's move — no gate, no signal, just "is there an unapproved reply." */
  turn: "writing" | "idle";
  /** Specialist deployments for this project so far -- see `ProjectInfo.runs`; already fetched per card, so this rides along at no extra cost. */
  runs: number;
};

export type ProjectInfo = {
  project: { id: string; title: string; createdAt: string; archivedAt: string | null };
  stage: number | null;
  artifacts: { versions: number; live: number; bytes: number; byKind: { kind: string; count: number; bytes: number }[] };
  /** Specialist deployments for this project: every stage that has ever deployed, and how many of those are stage 8 (build/execution). */
  runs: { total: number; builds: number };
  /** Agent-authored artifact versions -- see `./project-usage.ts` for what a browser can and cannot know about a turn's cost. */
  usage: ProjectUsage;
  /** Decisions committed in the project workflow view -- no spend, no lifecycle run to fold from any more. */
  decisions: { approved: number; refused: number; sentBack: number };
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
  /** Unknown unless the version is a package upload record; never a misleading 0. */
  sizeBytes?: number;
  /** `text/markdown` for a written document, `text/html` for a design. */
  mediaType?: string;
  createdAt: string;
  supersededByNodeId: string | null;
  /** `stepRef` is the stage-thread fold's lookup key: `${iterationRunId}/${stepId}` for the step that wrote this version. */
  provenance: { producer: string; agentRole?: string; providerId?: string; model?: string; stepRef?: string };
  /** The current version's real content digest, when the mounted package
   *  recorded one (CL-8723) — a sha256 over the actual bytes, unlike
   *  `contentHash` (an `<id>@<version>` pair). Used as a stage approval's
   *  `ref.sha256` for an artifact a specialist wrote directly. */
  contentSha256?: string | null;
};

/**
 * A stage-4 note recorded against a design node, folded from the node's own
 * artifact metadata (`metadata.sb.feedback`) — CL-8620. There is no lifecycle
 * run to fold this from any more (CL-8612 contract v6): the artifact record
 * is the whole history. Shape owned by `artifact-graph.ts`'s metadata
 * contract; re-exported here since it is what `designFeedback` answers.
 */
export type DesignFeedbackEntry = DesignFeedbackGraphEntry;

export type ProjectDetail = {
  project: {
    id: string;
    title: string;
    policy: unknown;
    archivedAt: string | null;
  };
  /** The workspace tenant artifacts are recorded under. */
  tenantId: string;
  /**
   * The project's current stage: the project workflow's own committed stage
   * (`project-view.ts`'s `loadProjectView`) — the workflow is the only
   * authority on this. Stays at 1 only while the workflow has not been
   * ensured yet for this project (a brand-new one, before its first stage
   * lands).
   */
  stage: number;
  /** Whether the project workflow has converged (stage 9 approved). */
  done: boolean;
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

const PROJECT_DECISION_SIGNAL = "project.decision";

/** The three compiled entry modules `scripts/project-workflow-pack.ts` writes
 *  to `apps/web/public/project-workflow/` (wired into `bun run ui:build`):
 *  the browser cannot run `Bun.build` itself, so it fetches these
 *  same-origin static files rather than compiling them client-side. */
async function projectWorkflowSource(): Promise<{ files: Record<string, string> }> {
  const files: Record<string, string> = {};
  for (const name of ["workflow.js", "actions.js", "loops.js"]) {
    const response = await fetch(`/project-workflow/${name}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`project workflow entry ${name} unavailable (HTTP ${String(response.status)})`);
    files[name] = await response.text();
  }
  return { files };
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

/**
 * Multipart upload straight to the mounted `@corbits/artifacts` module's
 * `POST /artifacts/upload` — the one entry point `Transport.fetch` (JSON-body
 * only) cannot drive. Refusals (415 unsupported type, 413 too large) come
 * back with the package's own message, surfaced verbatim as `ApiFailure.message`.
 */
async function uploadArtifactFile(tenantId: string, file: File): Promise<{ id: string; size?: number }> {
  const body = new FormData();
  body.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetch(`${hubOrigin()}/api/tenants/${encodeURIComponent(tenantId)}/artifacts/upload`, {
      method: "POST",
      credentials: hubCredentials(),
      body,
    });
  } catch {
    throw new ApiFailure({
      code: "host_unreachable",
      message: "That request did not reach the host. Try again, or reopen the window.",
      correlationId: "-",
      retryable: true,
    });
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const message = (parsed as { error?: string } | undefined)?.error ?? `The host answered ${response.status}.`;
    throw new ApiFailure(
      { code: response.status === 415 ? "unsupported_type" : response.status === 413 ? "too_large" : "internal_error", message, correlationId: "-", retryable: false },
      response.status,
    );
  }
  const artifact = (parsed as { artifacts?: { id: string; source?: { upload?: { size?: unknown } } }[] } | undefined)?.artifacts?.[0];
  if (!artifact) {
    throw new ApiFailure({ code: "internal_error", message: "Upload returned no artifact.", correlationId: "-", retryable: false });
  }
  const size = artifact.source?.upload?.size;
  return { id: artifact.id, ...(typeof size === "number" ? { size } : {}) };
}

/** The blob-backed artifact's raw bytes, over the package's own download route. */
async function downloadArtifactBytes(tenantId: string, artifactId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const response = await fetch(
    `${hubOrigin()}/api/tenants/${encodeURIComponent(tenantId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
    { credentials: hubCredentials() },
  );
  if (!response.ok) {
    throw new ApiFailure(
      { code: "internal_error", message: `The host answered ${response.status}.`, correlationId: "-", retryable: false },
      response.status,
    );
  }
  const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, mimeType };
}

/** Fetches a blob-backed artifact's bytes through the package's own download
 *  route and re-wraps them as a `data:` URL. */
async function downloadUploadedArtifact(tenantId: string, artifactId: string): Promise<string> {
  const { bytes, mimeType } = await downloadArtifactBytes(tenantId, artifactId);
  return `data:${mimeType};base64,${toBase64(bytes)}`;
}

/** In-flight/resolved `ensureStageAgent` calls, keyed `${projectId}:${stage}` --
 *  see that method's doc comment. */
const ensureStageAgentCalls = new Map<string, Promise<SpecialistDeployment>>();
const ensureStage5PackageAgentCalls = new Map<string, Promise<SpecialistDeployment>>();

/** Stage 5's specialist role -- every `package-<n>` deployment runs this,
 *  named explicitly so a rename of the kit role fails loudly here rather
 *  than silently deploying the wrong prompt. */
/** Stage 6's five roles, resolved once so a renamed kit role fails loudly here
 *  rather than silently deploying the architect's prompt under another name. */
function stage6RoleFor(roleKey: string): AgentRole {
  const role =
    roleKey === "requirements-author"
      ? agentById("requirements-author")
      : panelPrincipals().find((entry) => entry.id === `senior-engineer-${roleKey}`);
  if (!role) throw new Error(`kit role for stage 6 key "${roleKey}" is missing`);
  return role;
}

const STAGE_5_PACKAGE_ROLE = agentById("presentation-creator");
if (!STAGE_5_PACKAGE_ROLE) {
  throw new Error("kit role \"presentation-creator\" is missing");
}

const ensureStage1EvaluatorCalls = new Map<string, Promise<SpecialistDeployment>>();
const BRIEF_EVALUATOR_ROLE_KEY = "brief-evaluator";

/** Stage 1's brief-evaluator role -- named explicitly so a rename of the kit
 *  role fails loudly here rather than silently deploying the wrong prompt. */
const BRIEF_EVALUATOR_ROLE = agentById(BRIEF_EVALUATOR_ROLE_KEY);
if (!BRIEF_EVALUATOR_ROLE) {
  throw new Error(`kit role "${BRIEF_EVALUATOR_ROLE_KEY}" is missing`);
}

const ensureGuideAgentCalls = new Map<string, Promise<SpecialistDeployment>>();
const PRODUCT_GUIDE_ROLE_KEY = "product-guide";

/** The Product guide's role -- named explicitly so a rename of the kit role
 *  fails loudly here rather than silently deploying the stage specialist's
 *  prompt under the guide's name. */
const PRODUCT_GUIDE_ROLE = agentById(PRODUCT_GUIDE_ROLE_KEY);
if (!PRODUCT_GUIDE_ROLE) {
  throw new Error(`kit role "${PRODUCT_GUIDE_ROLE_KEY}" is missing`);
}
/** In-flight/resolved `ensureStage6RoleAgent` calls, keyed `${projectId}:${roleKey}` --
 *  see that method's doc comment. */
const ensureStage6RoleAgentCalls = new Map<string, Promise<SpecialistDeployment>>();

/** In-flight/resolved `ensureProjectWorkflow` calls, keyed by `projectId` --
 *  see that method's doc comment. Also `projectWorkflowView`/`decide`'s only
 *  way to find the deployment/run they read or signal. */
const ensureProjectWorkflowCalls = new Map<string, Promise<ProjectWorkflowDeployment>>();

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

export const STAKEHOLDER_ROLES: readonly Authority[] = AUTHORITIES.filter((role) => role !== "system");
const MAX_STAKEHOLDER_NAME = 80;

const EMPTY_DECK_SETTINGS: DeckSettings = { roles: {} };

/** The one workspace-scoped `deck_settings` artifact, newest live one if more than one exists. */
async function deckSettingsArtifact(
  transport: ReturnType<typeof createHubTransport>,
  workspaceTenantId: string,
): Promise<{ id: string; content: string } | null> {
  const artifacts = await listArtifacts(transport, workspaceTenantId);
  const candidates = artifacts.filter(
    (artifact) => artifact.archivedAt === null && (artifact.metadata as { sb?: Record<string, unknown> } | null)?.sb?.kind === DECK_SETTINGS_KIND,
  );
  const latest = candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!latest) return null;
  const artifact = await installerGetArtifact(transport, workspaceTenantId, latest.id);
  return artifact ? { id: artifact.id, content: artifact.content } : null;
}

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

const activeModelCache = new Map<string, { value: ActiveModel | null; at: number }>();
const ACTIVE_MODEL_CACHE_MS = 60_000;
function activeModelCacheClear(): void {
  activeModelCache.clear();
}

export const api = {
  status: () => request<HostStatus>("/status"),
  /**
   * Mints the embedded owner and signs this browser in as them, via a
   * `Set-Cookie` the host attaches to this response (`apps/hub/src/api-host.ts`'s
   * `/owner/session`). Embedded-only; a remote hub answers with a refusal.
   */
  mintOwner: () => post<{ ok: true }>("/owner/session"),
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
      const row = await connectApiKeyProvider(createHubTransport(), input);
      activeModelCacheClear();
      return row;
    } catch (cause) {
      installerFailure(cause);
    }
  },
  connectLocalProvider: async (input: { baseUrl?: string }): Promise<Provider> => {
    try {
      const row = await connectLocalProvider(createHubTransport(), input);
      activeModelCacheClear();
      return row;
    } catch (cause) {
      installerFailure(cause);
    }
  },
  connectOAuthProvider: async (
    input: { providerId: string; label: string },
    onAuthorizeUrl?: (url: string) => void,
  ): Promise<void> => {
    try {
      await connectOAuthProvider(createHubTransport(), input, onAuthorizeUrl);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  disconnectProvider: async (providerId: string): Promise<void> => {
    try {
      await disconnectProvider(createHubTransport(), providerId);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  refreshProviderModels: async (providerId: string): Promise<{ clearedModel: string | null }> => {
    try {
      const result = await refreshProviderModels(createHubTransport(), providerId);
      activeModelCacheClear();
      return result;
    } catch (cause) {
      installerFailure(cause);
    }
  },
  reorderProviders: async (orderedProviderIds: string[]): Promise<void> => {
    try {
      await reorderProviders(createHubTransport(), orderedProviderIds);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  /** Stops an in-flight provider sign-in on the host, releasing the loopback
   *  port its callback server holds so the next attempt can bind it. */
  cancelProviderSignIn: async (providerId: string): Promise<void> => {
    await createHubTransport()
      .fetch<unknown>("POST", `/api/oauth/${providerId}/cancel`)
      .catch(() => undefined);
  },
  selectProviderModel: async (providerId: string, canonicalName: string | null): Promise<void> => {
    try {
      await selectProviderModel(createHubTransport(), providerId, canonicalName);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  /**
   * The Settings Inference list (CL-8782): resolved-catalog rows in fallback
   * order, restricted rows included. Reads the hub catalog routes — never the
   * provider attach list, never a secret.
   */
  resolvedCatalog: async (): Promise<ResolvedCatalogRow[]> => {
    try {
      return await listResolvedCatalog(createHubTransport());
    } catch (cause) {
      installerFailure(cause);
    }
  },
  makeResolvedDefault: async (modelId: string): Promise<void> => {
    try {
      await makeResolvedDefault(createHubTransport(), modelId);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  moveResolvedModel: async (modelId: string, direction: ModelMoveDirection): Promise<void> => {
    try {
      await moveResolvedModel(createHubTransport(), modelId, direction);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  setResolvedRestricted: async (modelId: string, restricted: boolean): Promise<void> => {
    try {
      await setResolvedRestricted(createHubTransport(), modelId, restricted);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  setResolvedShadowed: async (providerRowIds: readonly string[], shadowed: boolean): Promise<void> => {
    try {
      await setResolvedShadowed(createHubTransport(), providerRowIds, shadowed);
      activeModelCacheClear();
    } catch (cause) {
      installerFailure(cause);
    }
  },
  /**
   * The model specialists are actually drafting with, for the workspace
   * header. `projectId`/`stage` name the stage panel asking, so a specialist
   * already deployed there reports its own pinned offering rather than the
   * tenant's current catalog default (the lowest-priority offering, CL-8781;
   * see `resolveActiveModel`'s doc). Cached
   * briefly per project/stage so switching between stages does not re-resolve
   * the whole catalog on every render; a provider mutation elsewhere in `api`
   * drops the whole cache so a change shows up on the next read.
   */
  activeModel: async (projectId?: string, stage?: number): Promise<ActiveModel | null> => {
    const key = `${projectId ?? ""}:${stage ?? ""}`;
    const cached = activeModelCache.get(key);
    if (cached && Date.now() - cached.at < ACTIVE_MODEL_CACHE_MS) {
      return cached.value;
    }
    try {
      const value = await resolveActiveModel(createHubTransport(), projectId, stage as Stage | undefined);
      activeModelCache.set(key, { value, at: Date.now() });
      return value;
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
  /**
   * What the workspace has spent on inference since the hub process last
   * started -- `packages/embed-hub/src/spend.ts`'s `GET /spend`, mounted on
   * the hub itself. Workspace-wide only: this revision has no mapping from a
   * workflow run to the project id the browser knows, so there is no honest
   * per-project breakdown to ask for yet (`../project-usage.js` says so in
   * the UI rather than omitting the fact). Nice-to-have, not core: a failure
   * here returns null rather than surfacing an error banner.
   */
  spend: async (): Promise<WorkspaceSpend | null> => {
    try {
      const transport = createHubTransport();
      const workspace = await resolveWorkspace(transport);
      if (!workspace) return null;
      const response = await transport.fetch<{ data: WorkspaceSpend }>(
        "GET",
        `/api/tenants/${workspace.tenantId}/spend`,
      );
      return response.data;
    } catch {
      return null;
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
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const [project, detail, deployments, ref] = await Promise.all([
        installerRequireProject(transport, projectId),
        loadProjectView(projectId, transport),
        listSpecialistDeployments(transport, workspaceTenantId, projectId),
        resolveProjectWorkflowRef(transport, workspaceTenantId, projectId).catch(() => null),
      ]);
      const view = ref ? await loadProjectWorkflowView(transport, workspaceTenantId, ref).catch(() => null) : null;
      const decisions = view?.decisions ?? [];
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
        runs: {
          total: deployments.length,
          builds: deployments.filter((deployment) => deployment.stage === 8).length,
        },
        usage: projectUsage(detail.nodes),
        decisions: {
          approved: decisions.filter((decision) => decision.kind === "approve" && decision.accepted).length,
          refused: decisions.filter((decision) => !decision.accepted).length,
          sentBack: decisions.filter((decision) => decision.kind === "send_back" && decision.accepted).length,
        },
        lastActivityAt: stamps.sort().at(-1) ?? project.createdAt.toISOString(),
      };
    }),
  /**
   * Imports a project bundle another copy of this app exported
   * (`project-export.ts`'s `assembleBundle`) as a NEW project — client-driven,
   * no host route. `parseBundle` gives a clear message for the wrong format,
   * version, or a missing key; `project-import.ts`'s `importPlan` re-keys
   * every bundled artifact's `sb` metadata to the new project id. The new
   * project's own workflow starts fresh at stage 1 — no approval is forged
   * from the bundle's history.
   */
  importProject: (raw: unknown) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const bundle = parseBundle(raw);
      return importProjectBundle(bundle, {
        createProject: async ({ title, policy }) => {
          const { project } = await installerCreateProject(transport, workspaceTenantId, {
            title,
            slug: projectSlug(),
            policy: policy as ProjectPolicy,
          });
          return { projectId: project.id };
        },
        createArtifact: async ({ title, content, sb }) => {
          const artifact = await installerCreateArtifact(transport, workspaceTenantId, {
            title,
            content,
            metadata: { sb },
          });
          return { id: artifact.id };
        },
      });
    }),
  /**
   * Hands files over with the problem; each becomes a `source_material`
   * artifact version the specialists read. Text/JSON stays on the plain
   * `POST /artifacts` path; anything else (pdf, xlsx, docx, pptx, images)
   * goes through the package's multipart `POST /artifacts/upload`, which
   * mints the artifact itself, then a metadata-only revise stamps `sb` on
   * it — `upload` carries no metadata field of its own. Unlike the deleted
   * host route, a same-named re-upload always starts a fresh artifact
   * rather than a new version of the same one.
   */
  attachMaterial: (projectId: string, files: File[]) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const attached = await Promise.all(
        files.map(async (file) => {
          const mediaType = file.type || "application/octet-stream";
          const sb = {
            projectId,
            kind: MATERIAL_KIND,
            stage: 1,
            variant: file.name,
            sourceVersionIds: [],
            provenance: { producer: "human" as const },
            mediaType,
          };
          if (mediaType.startsWith("text/") || mediaType === "application/json") {
            const content = await file.text();
            const artifact = await installerCreateArtifact(transport, workspaceTenantId, {
              title: file.name,
              content,
              metadata: { sb },
            });
            return { nodeId: artifact.id, name: file.name, mediaType, sizeBytes: file.size };
          }
          const uploaded = await uploadArtifactFile(workspaceTenantId, file);
          try {
            await installerReviseArtifact(transport, workspaceTenantId, uploaded.id, { metadata: { sb } });
          } catch (cause) {
            // Unstamped, the upload is invisible to the project forever (no
            // `sb.projectId` for the fold to match) — archive it rather than
            // leaving an orphan artifact behind, then surface the original
            // failure.
            await installerArchiveArtifact(transport, workspaceTenantId, uploaded.id).catch(() => {});
            throw cause;
          }
          // A companion `material_reading` version alongside the file: what a
          // specialist is actually handed for it. Extraction failing is not
          // an attach failure — the companion just says so instead. Nor is
          // the companion write itself: the file is already attached, so a
          // failure here is reported on the result, not thrown — a throw
          // here would tell the person the attach failed when it did not,
          // and a retry would duplicate the file.
          const readingText = await readMaterial({ name: file.name, mediaType, bytes: new Uint8Array(await file.arrayBuffer()) })
            .then((result) => result.text)
            .catch((cause) => `(Could not read ${file.name}: ${cause instanceof Error ? cause.message : String(cause)}.)`);
          const readingFailed = await installerCreateArtifact(transport, workspaceTenantId, {
            title: `${file.name} (reading)`,
            content: readingText,
            metadata: {
              sb: {
                projectId,
                kind: MATERIAL_READING_KIND,
                stage: 1,
                variant: file.name,
                sourceVersionIds: [uploaded.id],
                provenance: { producer: "human" as const },
                mediaType: "text/plain",
              },
            },
          })
            .then(() => false)
            .catch(() => true);
          return {
            nodeId: uploaded.id,
            name: file.name,
            mediaType,
            sizeBytes: uploaded.size ?? file.size,
            ...(readingFailed ? { readingFailed: true as const } : {}),
          };
        }),
      );
      return { attached };
    }),
  /**
   * Uploads a role's style-guide PowerPoint the same way `attachMaterial`
   * uploads any other file — through the multipart route, then a
   * metadata-only revise stamps `sb`. Workspace-scoped: no `projectId`, since
   * a style guide belongs to the role across every project.
   */
  uploadDeckTemplate: (file: File) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const mediaType = file.type || "application/octet-stream";
      const uploaded = await uploadArtifactFile(workspaceTenantId, file);
      const sb = { kind: DECK_TEMPLATE_KIND, variant: file.name, mediaType, provenance: { producer: "human" as const } };
      try {
        await installerReviseArtifact(transport, workspaceTenantId, uploaded.id, { metadata: { sb } });
      } catch (cause) {
        await installerArchiveArtifact(transport, workspaceTenantId, uploaded.id).catch(() => {});
        throw cause;
      }
      return { id: uploaded.id, name: file.name, mediaType };
    }),
  /** Every style-guide PowerPoint kept in the workspace, newest first. */
  listDeckTemplates: () =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const artifacts = await listArtifacts(transport, workspaceTenantId);
      const templates = artifacts
        .filter((artifact) => artifact.archivedAt === null && (artifact.metadata as { sb?: Record<string, unknown> } | null)?.sb?.kind === DECK_TEMPLATE_KIND)
        .map((artifact) => {
          const sb = (artifact.metadata as { sb?: Record<string, unknown> }).sb!;
          return {
            id: artifact.id,
            name: typeof sb.variant === "string" ? sb.variant : artifact.title,
            mediaType: typeof sb.mediaType === "string" ? sb.mediaType : "application/octet-stream",
            createdAt: artifact.createdAt,
          };
        });
      return { templates };
    }),
  /** Archives a style-guide PowerPoint, and unmaps it from any role that had it. */
  removeDeckTemplate: (templateArtifactId: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      await installerArchiveArtifact(transport, workspaceTenantId, templateArtifactId);
      const artifact = await deckSettingsArtifact(transport, workspaceTenantId);
      if (!artifact) return { settings: EMPTY_DECK_SETTINGS };
      const current = parseDeckSettings(artifact.content);
      let next = current;
      for (const [role, mapped] of Object.entries(current.roles)) {
        if (mapped === templateArtifactId) next = withRoleTemplate(next, role, null);
      }
      if (next !== current) {
        await installerReviseArtifact(transport, workspaceTenantId, artifact.id, { content: deckSettingsContent(next) });
      }
      return { settings: next };
    }),
  /** The workspace's role→template map, or an empty one when nothing is saved yet. */
  deckSettings: () =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const artifact = await deckSettingsArtifact(transport, workspaceTenantId);
      return { settings: artifact ? parseDeckSettings(artifact.content) : EMPTY_DECK_SETTINGS };
    }),
  /** Maps (or unmaps, when `templateArtifactId` is null) a role's style guide. */
  setDeckTemplateForRole: (role: string, templateArtifactId: string | null) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const artifact = await deckSettingsArtifact(transport, workspaceTenantId);
      const current = artifact ? parseDeckSettings(artifact.content) : EMPTY_DECK_SETTINGS;
      const next = withRoleTemplate(current, role, templateArtifactId);
      if (artifact) {
        await installerReviseArtifact(transport, workspaceTenantId, artifact.id, { content: deckSettingsContent(next) });
      } else {
        await installerCreateArtifact(transport, workspaceTenantId, {
          title: DECK_SETTINGS_TITLE,
          content: deckSettingsContent(next),
          metadata: { sb: { kind: DECK_SETTINGS_KIND, provenance: { producer: "human" as const } } },
        });
      }
      return { settings: next };
    }),
  /** The role's style guide theme, read fresh from its `.pptx`, or `null` when none is mapped. */
  deckTemplateThemeForRole: (role: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId): Promise<TemplateTheme | null> => {
      const artifact = await deckSettingsArtifact(transport, workspaceTenantId);
      const templateArtifactId = artifact ? parseDeckSettings(artifact.content).roles[role] : undefined;
      if (!templateArtifactId) return null;
      const { bytes } = await downloadArtifactBytes(workspaceTenantId, templateArtifactId);
      return await readTemplateTheme(bytes);
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
  /**
   * An artifact's current content, over the mounted `@corbits/artifacts`
   * module — no host route left. A file uploaded through `/artifacts/upload`
   * keeps its bytes in the module's own blob store, not `content`, so those
   * are fetched through the package's own `GET /artifacts/:id/download` and
   * re-wrapped as the same `data:` URL convention data-URL-backed artifacts
   * already return, so every reader downstream (inline preview, download)
   * stays on one code path.
   */
  artifactContent: async (tenantId: string, nodeId: string): Promise<{ content: string }> => {
    const artifact = await installerGetArtifact(createHubTransport(), tenantId, nodeId);
    if (!artifact) return { content: "" };
    const uploadId = (artifact.source as { upload?: { id?: unknown } }).upload?.id;
    if (typeof uploadId !== "string") return { content: artifact.content };
    return { content: await downloadUploadedArtifact(tenantId, nodeId) };
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
    try {
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
    } catch (cause) {
      // `installerGetArtifact` swallows its own failure into `null` (its usual
      // "not found" contract), but `installerReviseArtifact` does not -- a
      // refused or dropped write throws the hub client's raw `ApiError`
      // here, uncaught until now. Without this mapping it never becomes an
      // `ApiFailure`, so neither the popover's nor the page's `instanceof
      // ApiFailure` check recognizes it and both fall back to a raw
      // `String(cause)` instead of the host's own message (CL-8866).
      installerFailure(cause);
    }
  },
  designerSettings: () => loadDesignerSettings(createHubTransport()),
  deckDesigns: () => loadDeckDesigns(createHubTransport()),
  saveDeckDesignPreference: (key: string, value: unknown) =>
    saveDeckDesignPreference(createHubTransport(), key, value).catch((cause) => {
      installerFailure(cause);
    }),
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
   * Records a Stop: the mail agent's late reply is never cancelled — mail
   * has no such thing — so this marker is what keeps it from being read
   * back as the answer to the withdrawn turn. One `withdrawn_turns` artifact
   * per project, created on first use and revised (read-modify-write) after;
   * `@corbits/artifacts` exposes no version-conflict signal to retry against,
   * so a race between two writers is last-write-wins.
   */
  withdrawTurn: async (
    projectId: string,
    tenantId: string,
    entry: { messageId: string; stage: number },
  ): Promise<void> => {
    try {
      const transport = createHubTransport();
      const artifacts = await listArtifacts(transport, tenantId, { kind: WITHDRAWN_TURNS_KIND });
      const existing = artifacts.find(
        (artifact) =>
          artifact.archivedAt === null &&
          (artifact.metadata as { sb?: Record<string, unknown> } | null)?.sb?.["projectId"] === projectId,
      );
      const mark: WithdrawnMark = { messageId: entry.messageId, stage: entry.stage, at: new Date().toISOString() };
      if (existing) {
        const artifact = await installerGetArtifact(transport, tenantId, existing.id);
        const marks = [...parseWithdrawnTurns(artifact?.content ?? null), mark];
        await installerReviseArtifact(transport, tenantId, existing.id, { content: withdrawnTurnsContent(marks) });
        return;
      }
      await installerCreateArtifact(transport, tenantId, {
        title: "Withdrawn turns",
        content: withdrawnTurnsContent([mark]),
        metadata: {
          sb: {
            projectId,
            kind: WITHDRAWN_TURNS_KIND,
            stage: 0,
            mediaType: "application/json",
            provenance: { producer: "human" as const },
          },
        },
      });
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
      // Mailing a deployment whose sidecar is not placed yet loses the
      // message: the run never starts and the stage waits on a reply that
      // cannot come. Wait for the hub to call it deployed first.
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        workspaceTenantId,
        projectId,
        stage as Stage,
        hubOrigin(),
        // The hub credential binding for `publish_workspace`'s real upload is
        // off until a run has been seen to start with it: a stage 8 deployed
        // with it never produced a run, while every unbound stage does.
        // `publish_workspace` falls back to returning the archive inline and
        // the client persists it on approval.
false,
      );
      const ready = await waitForDeploymentDeployed(transport, workspaceTenantId, deployment.deploymentId);
      if (!ready) {
        throw new ApiFailure({
          code: "unavailable",
          message: `The stage ${stage} specialist did not finish starting up.`,
          correlationId: "-",
          retryable: true,
        });
      }
      return deployment;
    });
    call.catch(() => ensureStageAgentCalls.delete(key));
    ensureStageAgentCalls.set(key, call);
    return call;
  },
  /**
   * Stage 1's brief evaluator (CL-8736): its own deployed agent, running
   * `BRIEF_EVALUATOR_ROLE` (`agentById("brief-evaluator")`), mailed a copy of
   * the current draft and read back for an advisory verdict. Deploys lazily
   * — only when a caller actually has a draft worth judging, never on
   * project creation — onto its own asset (`ensureSpecialistDeployment`'s
   * `roleKey`, distinct from the stage's primary drafter). Memoised per
   * project the same way `ensureStageAgent` memoises per project/stage.
   */
  ensureStage1EvaluatorAgent: (projectId: string): Promise<SpecialistDeployment> => {
    const pending = ensureStage1EvaluatorCalls.get(projectId);
    if (pending) return pending;
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await request<HostStatus>("/status");
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        workspaceTenantId,
        projectId,
        1 as Stage,
        hubOrigin(),
        false,
        BRIEF_EVALUATOR_ROLE_KEY,
        BRIEF_EVALUATOR_ROLE,
      );
      const ready = await waitForDeploymentDeployed(transport, workspaceTenantId, deployment.deploymentId);
      if (!ready) {
        throw new ApiFailure({
          code: "unavailable",
          message: "The stage 1 brief evaluator did not finish starting up.",
          correlationId: "-",
          retryable: true,
        });
      }
      return deployment;
    });
    call.catch(() => ensureStage1EvaluatorCalls.delete(projectId));
    ensureStage1EvaluatorCalls.set(projectId, call);
    return call;
  },
  /**
   * The Product guide (CL-8737 restore): calm orientation across all nine
   * stages, running `PRODUCT_GUIDE_ROLE` (`agentById("product-guide")`) as
   * its own deployment -- never the stage's own specialist -- on a fixed
   * anchor stage (1, like the brief evaluator) so the guide never picks up a
   * stage-tool import (`specialistEntrySource`'s deck/posix/delivery
   * wiring keys off `stage`, not `role`) and stays project-wide, one
   * deployment reused across the nine stages rather than redeployed on every
   * stage change. Deploys lazily -- only when a person asks for guidance.
   */
  ensureGuideAgent: (projectId: string): Promise<SpecialistDeployment> => {
    const pending = ensureGuideAgentCalls.get(projectId);
    if (pending) return pending;
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await request<HostStatus>("/status");
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        workspaceTenantId,
        projectId,
        1 as Stage,
        hubOrigin(),
        false,
        PRODUCT_GUIDE_ROLE_KEY,
        PRODUCT_GUIDE_ROLE,
      );
      const ready = await waitForDeploymentDeployed(transport, workspaceTenantId, deployment.deploymentId);
      if (!ready) {
        throw new ApiFailure({
          code: "unavailable",
          message: "The product guide did not finish starting up.",
          correlationId: "-",
          retryable: true,
        });
      }
      return deployment;
    });
    call.catch(() => ensureGuideAgentCalls.delete(projectId));
    ensureGuideAgentCalls.set(projectId, call);
    return call;
  },
  /**
   * Stage 6's requirements author and four panel principals (CL-8737): each
   * is its own asset, deployed lazily the first time that role is needed --
   * never all five up front -- and running its own kit role's prompt.
   */
  ensureStage6RoleAgent: (projectId: string, roleKey: string): Promise<SpecialistDeployment> => {
    const key = `${projectId}:${roleKey}`;
    const pending = ensureStage6RoleAgentCalls.get(key);
    if (pending) return pending;
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await request<HostStatus>("/status");
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        workspaceTenantId,
        projectId,
        6 as Stage,
        hubOrigin(),
        false,
        roleKey,
        stage6RoleFor(roleKey),
      );
      const ready = await waitForDeploymentDeployed(transport, workspaceTenantId, deployment.deploymentId);
      if (!ready) {
        throw new ApiFailure({
          code: "unavailable",
          message: `The ${roleKey} specialist did not finish starting up.`,
          correlationId: "-",
          retryable: true,
        });
      }
      return deployment;
    });
    call.catch(() => ensureStage6RoleAgentCalls.delete(key));
    ensureStage6RoleAgentCalls.set(key, call);
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
   * Makes sure `projectId`'s `audienceIndex`-th stakeholder has its own
   * stage-5 package specialist deployed, and hands back its mail address --
   * `ensureStageAgent`'s ensure-and-reuse discipline, but keyed by audience
   * rather than stage: a project's audience count is dynamic, so this
   * deploys one `package-<audienceIndex>`-rolekeyed specialist lazily, only
   * the first time that stakeholder's package is actually requested,
   * running `STAGE_5_PACKAGE_ROLE` (`ensureSpecialistDeployment` still
   * resolves stage 5's role internally via `agentFor(5)`, which is the same
   * role).
   *
   * Memoised per `projectId:audienceIndex` for the same reason
   * `ensureStageAgent` memoises per `projectId:stage`: two mounts racing to
   * deploy the same audience's agent share the one in-flight promise
   * instead of each creating a deployment.
   */
  ensureStage5PackageAgent: (projectId: string, audienceIndex: number): Promise<SpecialistDeployment> => {
    const key = `${projectId}:${audienceIndex}`;
    const pending = ensureStage5PackageAgentCalls.get(key);
    if (pending) return pending;
    const roleKey = `package-${audienceIndex}`;
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await request<HostStatus>("/status");
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        workspaceTenantId,
        projectId,
        5 as Stage,
        hubOrigin(),
        false,
        roleKey,
      );
      const ready = await waitForDeploymentDeployed(transport, workspaceTenantId, deployment.deploymentId);
      if (!ready) {
        throw new ApiFailure({
          code: "unavailable",
          message: "That stakeholder's package specialist did not finish starting up.",
          correlationId: "-",
          retryable: true,
        });
      }
      return deployment;
    });
    call.catch(() => ensureStage5PackageAgentCalls.delete(key));
    ensureStage5PackageAgentCalls.set(key, call);
    return call;
  },
  /**
   * Makes sure `projectId`'s process authority (CL-8721/CL-8687) is deployed
   * and its one manual run triggered, the same ensure-and-reuse discipline
   * `ensureStageAgent` uses for a stage specialist: memoised per project so
   * two callers mounting at once share the in-flight deploy instead of
   * racing to create it twice. Every stage 1..`LAST_STAGE` is authorized for
   * the signed-in workspace owner -- the only principal that can approve
   * today; a future multi-principal policy is a later change to this one
   * call site.
   */
  ensureProjectWorkflow: (projectId: string): Promise<ProjectWorkflowDeployment> => {
    const pending = ensureProjectWorkflowCalls.get(projectId);
    if (pending) return pending;
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const workspace = await resolveWorkspace(transport);
      if (!workspace) throw new Error("The workspace is not installed yet.");
      const stages: ProjectWorkflowStageInput[] = Array.from({ length: 9 }, (_, index) => ({
        stage: index + 1,
        authorizedPrincipalIds: [workspace.principalId],
      }));
      const status = await request<HostStatus>("/status");
      const ref = await ensureProjectWorkflow(
        transport,
        sidecarCapabilityOf(status),
        await projectWorkflowSource(),
        lifecycleGitPush,
        workspaceTenantId,
        projectId,
        stages,
        await vendoredMemberFiles(await fetchClosureManifestOrThrow(), fetchClosureTarball),
      );
      const ready = await waitForDeploymentDeployed(transport, workspaceTenantId, ref.deploymentId);
      if (!ready) {
        throw new ApiFailure({
          code: "unavailable",
          message: "This project's workflow did not finish starting up.",
          correlationId: "-",
          retryable: true,
        });
      }
      cacheProjectWorkflowRef(projectId, ref);
      return ref;
    });
    call.catch(() => ensureProjectWorkflowCalls.delete(projectId));
    ensureProjectWorkflowCalls.set(projectId, call);
    return call;
  },
  /**
   * The project workflow's current view, folded from its run's own event
   * log -- see `foldProjectWorkflow`. Null when the project has no workflow
   * yet.
   *
   * The ref is resolved read-only (`findProjectWorkflow`, cached briefly by
   * `resolveProjectWorkflowRef`) rather than off `ensureProjectWorkflow`'s
   * own in-session memo, so this answers correctly on a fresh page load too
   * -- not only after this session's own `ensureProjectWorkflow` call.
   */
  projectWorkflowView: (projectId: string): Promise<ProjectWorkflowView | null> =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const ref = await resolveProjectWorkflowRef(transport, workspaceTenantId, projectId);
      if (!ref) return null;
      return loadProjectWorkflowView(transport, workspaceTenantId, ref);
    }),
  /**
   * Delivers one decision as the loop's `project.decision` signal,
   * `signalId = decision.decisionId`. A repeat of the exact same decision is
   * a no-op success (the reducer already dedups on `decisionId`, and the hub
   * itself treats a byte-identical retry as accepted); a DIFFERENT payload
   * under an already-used `decisionId` is the hub's `signal_id_conflict`
   * (409), surfaced as a hard error rather than swallowed.
   */
  decide: (projectId: string, decision: Record<string, unknown>): Promise<{ ok: true }> =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const ref = await ensureProjectWorkflowCalls.get(projectId);
      if (!ref) throw new Error(`project workflow for ${projectId} has not been deployed yet`);
      // A `signal_id_conflict` (409, a different payload under a reused
      // decisionId) is a hard error, not swallowed here -- it propagates as
      // an `ApiError` through `asWorkspaceOwner`'s normal failure path. A
      // byte-identical retry is accepted by the hub as a no-op, so it never
      // reaches this catch at all.
      await workflowsFor(transport, workspaceTenantId).signal(ref.deploymentId, {
        runId: ref.runId,
        signalName: PROJECT_DECISION_SIGNAL,
        signalId: decision["decisionId"] as string,
        payload: { decision },
      });
      return { ok: true as const };
    }),
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
   * Persists the stage 8 build specialist's `publish_workspace` tool result
   * as the stage's real `build_evidence` artifact — bytes and media type,
   * not the chat text `persistStageDraft` would otherwise write. Without
   * this the workspace `publish_workspace` tars only ever lived in the tool
   * result the specialist's own turn saw; the run's warm workspace is gone
   * once the allocation is released, so this is the only copy that
   * survives.
   */
  persistBuildEvidence: (
    projectId: string,
    bundle: { fileName: string; mediaType: string; dataUri: string; sizeBytes: number },
    sourceVersionIds: string[] = [],
  ) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const artifact = await installerCreateArtifact(transport, workspaceTenantId, {
        title: bundle.fileName,
        content: bundle.dataUri,
        metadata: {
          sb: {
            projectId,
            kind: STAGE_DRAFT_KIND[8]!,
            stage: 8,
            mediaType: bundle.mediaType,
            sourceVersionIds,
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
   * lands in its next turn, and records each anchored comment — plus, when
   * an overall note exists, one un-anchored entry for it — on the node's own
   * artifact metadata (`sb.feedback`) via `reviseArtifact` so it survives to
   * fold back into `feedbackByNode` on reload — CL-8620, extended with a
   * per-comment `disposition` (CL-8699). `mailBody` is exactly what the
   * specialist is mailed: the caller builds it (typically the overall note
   * plus the deterministic revision prompt, so the mail still names every
   * anchor), which is why it is not derived from `comments` here. The
   * specialist's mail address comes from `ensureStageAgent`, deployed lazily
   * the same way the workspace's own composer resolves it. The node's
   * project id rides its own `sb.projectId` (every stage draft is written
   * with one), so this needs nothing beyond the node itself.
   */
  submitDesignFeedback: (
    tenantId: string,
    node: { id: string; title: string },
    args: { mailBody: string; comments: readonly { anchor?: DesignFeedbackEntry["anchor"]; text: string }[] },
  ) =>
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
      const at = new Date().toISOString();
      const entries: DesignFeedbackEntry[] = args.comments.map((comment, index) => ({
        id: `${node.id}:${existing.length + index}`,
        nodeId: node.id,
        ...(comment.anchor ? { anchor: comment.anchor } : {}),
        text: comment.text,
        at,
        disposition: "open",
      }));
      const deployment = await api.ensureStageAgent(projectId, 4);
      await Promise.all([
        api.sendStageMail(tenantId, deployment.address, { body: `Feedback on ${node.title}: ${args.mailBody}` }),
        installerReviseArtifact(transport, tenantId, node.id, {
          metadata: { sb: { ...sb, feedback: [...existing, ...entries] } },
        }),
      ]);
    }),
  /**
   * Records a person's disposition on one already-recorded feedback comment,
   * by id — the only way `sb.feedback[].disposition` changes; a new design
   * version never touches it (CL-8699). Same metadata-revise path as
   * `submitDesignFeedback`.
   */
  setDesignFeedbackDisposition: (
    tenantId: string,
    node: { id: string },
    entryId: string,
    disposition: DesignFeedbackDisposition,
  ) =>
    asWorkspaceOwner(async (transport) => {
      const artifact = await installerGetArtifact(transport, tenantId, node.id).catch(() => null);
      const sb = (artifact?.metadata as { sb?: Record<string, unknown> } | null)?.sb ?? {};
      const existing = Array.isArray(sb.feedback) ? (sb.feedback as DesignFeedbackEntry[]) : [];
      const updated = withDisposition(existing, entryId, disposition, new Date().toISOString());
      await installerReviseArtifact(transport, tenantId, node.id, {
        metadata: { sb: { ...sb, feedback: updated } },
      });
    }),
};
