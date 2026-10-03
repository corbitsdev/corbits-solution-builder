/**
 * The API client.
 *
 * The one place the interface talks to the host. Every call goes through
 * `request`, so an error contract change is a change here and nowhere else.
 * Clients read and command; they never write persistence.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { AUTHORITIES, type Authority, type Stage } from "@solutions-builder/app/ledger";
import { agentById, agentFor, panelPrincipals, type AgentRole } from "@solutions-builder/app/kit";
import { languageGuidance, type LanguageSettings } from "@solutions-builder/app/language-settings";
import type { Quote, StageTurn } from "@solutions-builder/app/stage-prompt";
import { newestRun, runStateOf, topLevelRunIds, UNKNOWN_RUN, type SpecialistRun } from "./specialist-run-state.ts";
import {
  ApiError as HubApiError,
  archiveArtifact as installerArchiveArtifact,
  createArtifact as installerCreateArtifact,
  createProject as installerCreateProject,
  delegateWorkspaceDefaultsIfSealed,
  ENDED_DEPLOYMENT_STATUSES,
  ensureProjectWorkflow,
  ensureSpecialistDeployment,
  getArtifact as installerGetArtifact,
  install as installerInstall,
  InstallerError,
  installProjectAuthority,
  installState as installerInstallState,
  listArtifacts,
  listSpecialistDeployments,
  liveDelegationStore,
  myPrincipalIn,
  pushSourceTree,
  requireProject as installerRequireProject,
  resolveWorkspace,
  reviseArtifact as installerReviseArtifact,
  revokeAllDelegations,
  stageSpecialistAddresses,
  stageSpecialistStatus,
  switchSpecialistDeployment,
  updateProject as installerUpdateProject,
  upgradeWorkspace as installerUpgradeWorkspace,
  vendoredMemberFiles,
  waitForDeploymentPlacement,
  waitForPark,
  type PlacementResult,
  workflowsFor,
  workspaceOwnedCredentialIds,
  type ClosureManifest,
  type ClosureSource,
  type EnsureProgress,
  type EnsuredProjectWorkflow,
  type InstallState as PackageInstallState,
  type ProjectPolicy,
  type ProjectWorkflowDeployment,
  type ProjectWorkflowStageInput,
  type SidecarCapability,
  type SpecialistDeployment,
  type SpecialistDeploymentStatus,
  type WorkflowGitPush,
  readLanguageSettings,
  saveLanguageSettings as installerSaveLanguageSettings,
} from "@solutions-builder/installer";
import { loadProjectWorkflowView, type ProjectWorkflowView } from "./project-workflow.ts";
import { cacheProjectWorkflowRef, resolveProjectWorkflowRef } from "./project-workflow-ref.ts";
import { parseBundle } from "./project-export.ts";
import { importProject as importProjectBundle } from "./project-import.ts";
import { importLegacyProject, isLegacyBundle, parseLegacyBundle } from "./legacy-import.ts";
import { ArchiveRefused, expandArchives } from "./material-archive.ts";
import { replayAdoption } from "./adoption-replay.ts";
import { DECK_DESIGN_DOCUMENT_KIND, DECK_DESIGN_READING_KIND, DELIVERY_MANIFEST_KIND, MATERIAL_KIND, MATERIAL_READING_KIND } from "@solutions-builder/app/artifacts";
import { readMaterial, readingHasText } from "./material-reading.ts";
import { pdfLook } from "./pdf-look.ts";
import {
  designDocumentRefusal,
  designDocumentFormat,
  designDocumentsFrom,
  designGuidelinesBlock,
  designThemeOf,
  effectiveDesignDocuments,
  readingIdsFor,
  type DeckBrief,
  type DeckDesignDocument,
  type DesignDocumentScope,
} from "./deck-design-documents.ts";
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
import { prunePlan, type PrunePlan } from "./prune-versions.ts";
import { findArtifact, listProjectArtifacts } from "./project-artifacts.ts";
import { addressesByMailTenant, mailTenantFor, parentTenantOf } from "./project-tenants.ts";
import { toBase64 } from "./base64.ts";
import { beginBusy } from "./busy.ts";
import { openCreatedProject } from "./create-project-open.ts";
import type { Transport } from "@intx/hub-client";
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
import { deckDesigns as loadDeckDesigns, guidanceFor, saveDeckDesignPreference } from "./deck-design-settings.ts";
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
  settleProviderCatalog,
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
  kind: "switch_provider" | "reconnect" | "retry" | "send_back" | "ask_specialist";
  label: string;
  providerId?: string;
  /** `send_back` only: the stage the way out returns the project to, and
   *  the reason to seed the send-back with. Raised client-side by a
   *  pre-check (`stage-evidence.ts`), never by the host. */
  targetStage?: number;
  reason?: string;
  /** `ask_specialist` only: the message the action sends to the stage's
   *  specialist on the person's behalf (#325). Client-side as well. */
  message?: string;
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

/** The host's Google Drive connection, as `GET /api/google-drive` reports it. */
export type GoogleDriveStatus = {
  readonly connected: boolean;
  readonly email: string | null;
  readonly clientId: string | null;
  readonly login: { status: "idle" } | { status: "pending" } | { status: "error"; message: string };
};
/** A deck uploaded as a Google Slides document. */
export type UploadedSlides = { readonly id: string; readonly url: string; readonly name: string };

/** `GET /api/build/worker`: which coding agent stage 8 runs, and whether it is on this host. */
export type BuildWorkerStatus = {
  bridge: string;
  capabilities: Record<string, boolean>;
  platform: "macos" | "linux" | "windows";
  settings: { worker: string; executable: string };
  worker: { id: string; label: string; command: string };
  workers: { id: string; label: string; executable: string }[];
  available: boolean;
  detail: string;
  /** How to get the worker on this host, when it is absent; null when it is present or failing for another reason. */
  install: {
    platform: "macos" | "linux" | "windows";
    binary: string;
    text: string;
    command: string | null;
    url: string | null;
    verified: boolean;
  } | null;
  checkedAt: string;
};

/** What the bounded bridge reported when a worker ended: final text and an exit status, nothing synthesised. */
export type BridgeOutcome = {
  bridgeId: string;
  worker: string;
  command: string;
  available: boolean;
  exitStatus: number | null;
  signal: string | null;
  finalText: string;
  stderrTail: string;
  workspace: string;
  turnLog: string | null;
  turns: number | null;
  toolCalls: number | null;
  startedAt: string;
  endedAt: string;
  checkpointRef: null;
};

/** One build attempt as the host records it (`apps/hub/src/build-attempts.ts`). */
export type BuildAttempt = {
  attempt: number;
  /** `detached`: a worker an earlier run of the host started is still alive, known only by its process group. `lost`: started, never recorded as ended, and gone. */
  state: "running" | "ended" | "unavailable" | "detached" | "lost";
  startedAt: string | null;
  endedAt: string | null;
  continuedFrom: number | null;
  outcome: BridgeOutcome | null;
  workspace: string;
};

/** The frozen material the host assembles the worker's prompt from. */
export type BuildPromptMaterial = {
  planText: string;
  requirementsText: string;
  designText: string;
  stackBlock: string;
  target: string;
  planRef: string;
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
  /** The host's start when its sidecars die with it: a deployment from before then is not waited on. */
  sidecarsLostBefore: string | null;
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
  enabledModels: string[];
  selectedOfferingId: string | null;
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
  /** When the project's tenant was created -- already read per card (`record.createdAt`), so this rides along at no extra cost. */
  createdAt: string;
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

/** What `api.importProject` reports: the new project, what was written, and,
 *  for a bundle from `main`, where its old ledger was landed. */
export type ImportOutcome = {
  readonly projectId: string;
  readonly artifacts: number;
  readonly conversations: number;
  /** Version 1 bundles only: versions written across every artifact. */
  readonly versions?: number;
  /** Version 1 bundles only: the stage the workflow reports after the
   *  replay (null when there was nothing to replay or it never started),
   *  why the replay stopped short, and what the plan could not do. */
  readonly landing?: { readonly landed: number | null; readonly stopped: string | null; readonly notes: readonly string[] };
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
  provenance: { producer: string; agentRole?: string; attempt?: number; providerId?: string; model?: string; stepRef?: string };
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
  /** The project's own tenant (#29): where its artifacts, specialists and
   *  mail are, and what every page-level read and write is scoped to. */
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

const UNTITLED = "Untitled project";
const URL_TOKEN = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*$/i;

/**
 * The fallback name until the project workflow's `name` step names the
 * project for real (`adoptGeneratedTitle`): the opening statement's first
 * clause, links dropped, trimmed to about five words, never the whole
 * paragraph. Links are dropped before the clause is cut, since a URL's own
 * dots would otherwise end it.
 */
export function titleFromProblem(problem: string): string {
  const line = problem.trim().split("\n")[0]!.trim();
  const words = line.split(/\s+/).filter((word) => word && !URL_TOKEN.test(word)).join(" ");
  const clause = (words.split(/[.!?]/)[0] ?? words).trim() || words;
  const short = clause.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  if (!short) return UNTITLED;
  return short.length > TITLE_MAX ? `${short.slice(0, TITLE_MAX - 1).trimEnd()}…` : short;
}

/** The opening problem statement `createProject` stored, or null when it was created without one. */
async function openingOf(transport: Transport, projectId: string): Promise<{ body: string; createdAt: string } | null> {
  const graph = await artifactGraphFor(transport, projectId);
  const node = graph.nodes.find((entry) => entry.kind === MATERIAL_KIND && entry.variant === OPENING_VARIANT);
  if (!node) return null;
  // The project's own tenant: where its artifacts live since #29.
  const artifact = await installerGetArtifact(transport, projectId, node.id);
  if (!artifact) return null;
  return { body: artifact.content, createdAt: node.createdAt };
}

/** Projects whose `name` reply this session has already settled, so a poll does not re-read the record. */
const titlesSettled = new Set<string>();

/**
 * Writes the `name` step's reply as the project's title, only while the title
 * is still the fallback `createProject` derived from the opening: a title a
 * person chose, or one already adopted, is never overwritten.
 */
async function adoptGeneratedTitle(transport: Transport, projectId: string, generated: string): Promise<void> {
  if (titlesSettled.has(projectId)) return;
  const [record, opening] = await Promise.all([installerRequireProject(transport, projectId), openingOf(transport, projectId)]);
  const title = generated.slice(0, TITLE_MAX).trim();
  if (opening && title && record.title === titleFromProblem(opening.body)) {
    await installerUpdateProject(transport, projectId, { title });
  }
  titlesSettled.add(projectId);
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

/** The host's placement facts right now, for a pick that must agree with a deploy's (CL-9698). */
async function hostSidecar(): Promise<SidecarCapability> {
  return sidecarCapabilityOf(await request<HostStatus>("/status"));
}

/**
 * Why a deployment the page waited on is not placed, in the hub's own terms
 * (CL-9698): released or failed by the hub, no longer listed, or a hub that
 * placed nothing for the stall bound. Each is a different thing to fix.
 */
function placementFailure(what: string, result: Exclude<PlacementResult, { outcome: "placed" }>): ApiFailure {
  const message =
    result.outcome === "stalled"
      ? `The hub stopped placing ${what} before it was ready.`
      : result.status === "missing"
        ? `The hub no longer lists ${what}.`
        : `The hub ended ${what} before it was placed (${result.status}).`;
  return new ApiFailure({ code: "unavailable", message, correlationId: "-", retryable: true });
}

export function sidecarCapabilityOf(status: Pick<HostStatus, "canPlaceSidecars" | "sidecarsLostBefore">): SidecarCapability {
  return { canPlaceSidecars: status.canPlaceSidecars, ...(status.sidecarsLostBefore === null ? {} : { sidecarsLostBefore: status.sidecarsLostBefore }) };
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

/** The lifecycle deploy's closure source: the static tarballs
 *  `scripts/pack-closure-static.ts` ships, read back and extracted in the
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
/**
 * The origin a specialist's sidecar dials for its artifact tool calls, and
 * the one `lifecycleGitPush` pushes to. `hubOrigin()` is `""` in the embedded
 * app, where the hub is same-origin; that empty string must never reach the
 * installer, which pins the `sb-workflow-artifacts` provider to it and the
 * hub then refuses to launch any specialist bound to that provider, silently.
 */
function specialistHubOrigin(): string {
  return hubOrigin() || window.location.origin;
}

/**
 * Whether a deployment this session remembers is still the one to mail
 * (#167). A memo outlives a host restart, which fails every deployment and
 * places replacements; mail to the remembered address is then refused as
 * terminal. The remembered one stands while the live pick is still it; it
 * is dropped once another deployment is the pick, or once it has ended and
 * nothing has replaced it yet. A status read that fails keeps the memo, as
 * `ensureStageAgent` always has.
 */
async function memoStillLive(projectId: string, stage: Stage, roleKey: string | undefined, remembered: SpecialistDeployment): Promise<boolean> {
  const fresh = await asWorkspaceOwner(async (transport) => stageSpecialistStatus(transport, projectId, stage, roleKey, await hostSidecar())).catch(() => null);
  if (!fresh) return true;
  if (fresh.deploymentId !== remembered.deploymentId) return false;
  return !ENDED_DEPLOYMENT_STATUSES.has(fresh.status);
}

const projectRunnableCalls = new Map<string, Promise<void>>();

/**
 * What every deploy into a project needs first: the host's status, and a
 * project that can run something. A project created before this interface
 * delegated at creation is sealed -- nothing the workspace holds is usable
 * in its tenant -- and since #29 that is where its specialists and workflow
 * deploy, so opening it would only ever fail. It is given the workspace's
 * own credentials once, the default a new project gets, before the first
 * deploy; a set the owner chose is never touched. Memoised per project so
 * concurrent deploys on one open share the one consent write.
 */
async function readyToDeploy(transport: ReturnType<typeof createHubTransport>, workspaceTenantId: string, projectId: string): Promise<HostStatus> {
  let pending = projectRunnableCalls.get(projectId);
  if (!pending) {
    pending = delegateWorkspaceDefaultsIfSealed(liveDelegationStore(transport, workspaceTenantId), projectId).then(() => undefined);
    pending.catch(() => projectRunnableCalls.delete(projectId));
    projectRunnableCalls.set(projectId, pending);
  }
  await pending;
  return request<HostStatus>("/status");
}

const lifecycleGitPush: WorkflowGitPush = ({ scope, assetKind, assetName, token, tree, message }) => {
  const base = specialistHubOrigin();
  const url = new URL(
    `/api/tenants/${encodeURIComponent(scope)}/assets/${assetKind}/${assetName}.git`,
    base,
  ).toString();
  return pushSourceTree({ url, token, tree, message });
};

function installerFailure(cause: unknown): never {
  if (cause instanceof ApiFailure) throw cause;
  if (cause instanceof ArchiveRefused) {
    throw new ApiFailure({ code: "validation_failed", message: cause.message, correlationId: "-", retryable: false });
  }
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
  if (response.status === 404) {
    // A project's older upload can still sit in the workspace tenant (#29);
    // the same read against the parent answers it there.
    const parentId = await parentTenantOf(createHubTransport(), tenantId).catch(() => null);
    if (parentId) return downloadArtifactBytes(parentId, artifactId);
  }
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

/** Stage 5's specialist role -- the one deployment every stakeholder's
 *  package is written by (#41 step 3), named explicitly so a rename of the
 *  kit role fails loudly here rather than silently recording a package
 *  under the wrong provenance. */
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
const ensureProjectWorkflowCalls = new Map<string, Promise<EnsuredProjectWorkflow>>();

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

/** The design documents on one tenant — the workspace's, or one project's own — newest first. */
async function listDesignDocuments(
  transport: ReturnType<typeof createHubTransport>,
  tenantId: string,
  scope: DesignDocumentScope,
): Promise<DeckDesignDocument[]> {
  return designDocumentsFrom(await listArtifacts(transport, tenantId), scope);
}

/** The theme of the style-guide PowerPoint mapped to `role`, read fresh from its bytes; null when none is mapped. */
async function roleStyleGuideTheme(
  transport: ReturnType<typeof createHubTransport>,
  workspaceTenantId: string,
  role: string,
): Promise<TemplateTheme | null> {
  const artifact = await deckSettingsArtifact(transport, workspaceTenantId);
  const templateArtifactId = artifact ? parseDeckSettings(artifact.content).roles[role] : undefined;
  if (!templateArtifactId) return null;
  const { bytes } = await downloadArtifactBytes(workspaceTenantId, templateArtifactId);
  return await readTemplateTheme(bytes);
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

/**
 * One ensure of `projectId`'s workflow, memoised by the callers above:
 * `extra` carries a repair (#299) or nothing.
 */
function ensureProjectWorkflowWith(projectId: string, extra: { repair?: boolean }): Promise<EnsuredProjectWorkflow> {
  return asWorkspaceOwner(async (transport, workspaceTenantId) => {
    const workspace = await resolveWorkspace(transport);
    if (!workspace) throw new Error("The workspace is not installed yet.");
    // The same person is a different principal in each tenant, and the
    // hub stamps a decision with the caller's principal in the tenant it
    // is signalled in: the project's own since #29. So the owner's
    // principal there authorises every stage, beside the workspace one a
    // legacy deployment still live in the workspace is signalled as
    // (#165).
    const ownerInProject = await myPrincipalIn(transport, projectId);
    const authorizedPrincipalIds = [...new Set([...(ownerInProject ? [ownerInProject] : []), workspace.principalId])];
    const stages: ProjectWorkflowStageInput[] = Array.from({ length: 9 }, (_, index) => ({
      stage: index + 1,
      authorizedPrincipalIds,
    }));
    const status = await readyToDeploy(transport, workspaceTenantId, projectId);
    const opening = await openingOf(transport, projectId);
    // What the ensure step is doing, under the busy strip's clock: a click
    // that waits on it (a decision, a vote) otherwise showed only its own
    // name for as long as a history replayed (#295).
    let release = beginBusy("Starting the project's workflow");
    const onProgress = (progress: EnsureProgress) => {
      release();
      release = beginBusy(ensureProgressLabel(progress));
    };
    let ref: EnsuredProjectWorkflow;
    try {
      ref = await ensureProjectWorkflow(
        transport,
        sidecarCapabilityOf(status),
        await projectWorkflowSource(),
        lifecycleGitPush,
        projectId,
        stages,
        await vendoredMemberFiles(await fetchClosureManifestOrThrow(), fetchClosureTarball),
        { ...(opening ? { problemStatement: opening.body } : {}), onProgress, ...extra },
      );
    } finally {
      release();
    }
    const placement = await waitForDeploymentPlacement(transport, ref.tenantId, ref.deploymentId);
    if (placement.outcome !== "placed") throw placementFailure("this project's workflow", placement);
    cacheProjectWorkflowRef(projectId, ref);
    return ref;
  });
}

/** Stage 6's requirements author, as `stage6.tsx` names it. */
export const STAGE6_REQUIREMENTS_ROLE_KEY = "requirements-author";

/**
 * Writes one version of a stage document into the project's artifact graph.
 * A stage's draft can be persisted more than once (a send-back and
 * re-approval, or `promote()` restoring an older version forward) -- each
 * write must supersede the lineage's current head, or the graph fold
 * (`foldArtifactGraph`) never links them and every write shows up as its
 * own unrelated version 1 (the "v1 v1 v1" defect). The lookup is
 * best-effort: a tenant-wide list that fails here must never block the
 * draft itself from being saved -- falling back to no `supersedes` is
 * exactly the earlier (already shipped) behavior, not a regression.
 */
async function persistDraftOfKind(
  transport: ReturnType<typeof createHubTransport>,
  projectId: string,
  args: { stage: number; kind: string; content: string; sourceVersionIds: string[]; title: string; agentRole?: string; target?: string; variant?: string },
): Promise<{ artifactId: string; versionId: string; contentHash: string }> {
  const previousHead = await artifactGraphFor(transport, projectId)
    .then(
      (graph) =>
        graph.nodes
          .filter((node) => node.stage === args.stage && node.kind === args.kind && node.variant === (args.variant ?? null) && node.supersededByNodeId === null)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0],
    )
    .catch(() => undefined);
  const artifact = await installerCreateArtifact(transport, projectId, {
    title: args.title,
    content: args.content,
    metadata: {
      sb: {
        projectId,
        kind: args.kind,
        stage: args.stage,
        ...(args.variant ? { variant: args.variant } : {}),
        mediaType: "text/markdown",
        sourceVersionIds: args.sourceVersionIds,
        provenance: {
          producer: "agent" as const,
          ...(args.agentRole ? { agentRole: args.agentRole } : {}),
        },
        ...(args.target ? { target: args.target } : {}),
        ...(previousHead ? { supersedes: previousHead.id } : {}),
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
}

/**
 * A role with the workspace's output language in its instructions (#411):
 * what every specialist is deployed with, so documents, replies and the
 * text of any software it builds come out in that language. Read at deploy
 * time off the workspace tenant; the default is American English.
 */
async function localizedRole(transport: ReturnType<typeof createHubTransport>, workspaceTenantId: string, role: AgentRole): Promise<AgentRole> {
  const settings = await readLanguageSettings(transport, workspaceTenantId).catch(() => null);
  if (!settings) return role;
  return { ...role, system: `${role.system}\n\n${languageGuidance(settings)}` };
}

export const api = {
  status: () => request<HostStatus>("/status"),
  /** The build lane: the chosen worker, whether it is on this host, and how to get it when not. */
  buildWorker: () => request<BuildWorkerStatus>("/build/worker"),
  setBuildWorker: (patch: { worker?: string; executable?: string }) =>
    request<BuildWorkerStatus>("/build/worker", { method: "PUT", body: JSON.stringify(patch) }),
  buildAttempts: (projectId: string) => request<{ attempts: BuildAttempt[] }>(`/projects/${projectId}/build/attempts`),
  startBuildAttempt: (projectId: string, prompt: BuildPromptMaterial, continueFrom?: number) =>
    request<{ attempt: BuildAttempt }>(`/projects/${projectId}/build/attempts`, {
      method: "POST",
      body: JSON.stringify({ prompt, ...(continueFrom === undefined ? {} : { continueFrom }) }),
    }),
  buildAttempt: (projectId: string, attempt: number) =>
    request<{ attempt: BuildAttempt; log: string; prompt: string | null }>(`/projects/${projectId}/build/attempts/${String(attempt)}`),
  cancelBuildAttempt: (projectId: string, attempt: number) =>
    request<{ ok: true }>(`/projects/${projectId}/build/attempts/${String(attempt)}/cancel`, { method: "POST", body: "{}" }),
  /** Archives, hashes and probes an ended attempt on the host; the bytes come back inline for the client to record as the build archive. */
  packageBuildAttempt: (projectId: string, attempt: number, body: { fileName?: string; targets?: unknown[] }) =>
    request<{ packaged: { fileName: string; mediaType: string; sizeBytes: number; sha256: string; dataUri: string; manifest: { attempt: string } & Record<string, unknown>; verification: { complete: boolean; failed: string[]; targets: { target: string; ranSuccessfully: boolean; transcript: string }[] } } }>(
      `/projects/${projectId}/build/attempts/${String(attempt)}/package`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /**
   * Mints the embedded owner and signs this browser in as them, via a
   * `Set-Cookie` the host attaches to this response (`apps/hub/src/api-host.ts`'s
   * `/owner/session`). Embedded-only; a remote hub answers with a refusal.
   */
  mintOwner: () => post<{ ok: true }>("/owner/session"),
  /**
   * The host's Google Drive connection (#233): one click from a
   * stakeholder's slides to a Google Slides document. The sign-in is the
   * host's loopback OAuth flow, so `connect` returns the consent URL the
   * host also opens in the browser, and `awaitLogin` polls until the
   * tokens land. Google's tokens never reach this window; `uploadSlides`
   * posts the PowerPoint and gets the document's link back.
   */
  googleDrive: {
    status: () => request<GoogleDriveStatus>("/google-drive"),
    connect: (client: { clientId: string; clientSecret: string }) => post<{ authorizeUrl: string }>("/google-drive/connect", client),
    cancel: () => post<{ status: "idle" }>("/google-drive/cancel"),
    disconnect: () => post<GoogleDriveStatus>("/google-drive/disconnect"),
    uploadSlides: (slides: { name: string; pptxBase64: string }) => post<UploadedSlides>("/google-drive/slides", slides),
    awaitLogin: async (timeoutMs = 180_000): Promise<GoogleDriveStatus> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = await request<GoogleDriveStatus>("/google-drive");
        if (status.connected && status.login.status !== "pending") return status;
        if (status.login.status === "error") throw new Error(status.login.message);
        if (status.login.status === "idle") throw new Error("The sign-in was cancelled.");
        if (Date.now() >= deadline) throw new Error("Sign-in timed out. Try again.");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
  },
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
      return state;
    } catch (cause) {
      installerFailure(cause);
    }
  },
  upgradeWorkspace: async (): Promise<void> => {
    const status = await request<HostStatus>("/status");
    if (status.hub.mode !== "embedded") return;
    try {
      await installerUpgradeWorkspace(createHubTransport());
    } catch (cause) {
      installerFailure(cause);
    }
    // Off the boot screen's clock: the repairs are rare writes, and a page
    // that reads the catalog before they land sees the rows as they were.
    void settleProviderCatalog(createHubTransport())
      .then((changed) => {
        if (changed) activeModelCacheClear();
      })
      .catch((cause: unknown) => {
        console.warn("provider catalog repairs did not run", cause);
      });
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
      // A project tenant starts sealed: only the credentials named here are
      // usable inside it, and that is what its specialists deploy against
      // (#29). This interface offers no choice at creation, and a project
      // that can run no specialist is not one anyone meant to open, so a
      // payload naming none delegates every workspace-owned credential the
      // workspace holds. Personal credentials never cross (the installer
      // refuses them), so they are left out here too.
      const delegatedCredentialIds =
        payload.delegatedCredentialIds ?? (await workspaceOwnedCredentialIds(liveDelegationStore(transport, workspace.tenantId)));
      const { project } = await installerCreateProject(transport, workspace.tenantId, {
        title,
        slug: projectSlug(),
        policy: payload.policy,
        delegatedCredentialIds,
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
            await installerCreateArtifact(transport, project.id, {
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
        listSpecialistDeployments(transport, projectId),
        resolveProjectWorkflowRef(transport, projectId).catch(() => null),
      ]);
      const view = ref ? await loadProjectWorkflowView(transport, ref).catch(() => null) : null;
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
   *
   * A version 1 bundle, exported from `main`, carries every artifact
   * version and the ledger the project's position lived in
   * (`legacy-import.ts`). Its artifacts come in with all their versions,
   * and once the new project's workflow is running the old ledger is
   * replayed on it as real decisions (`adoption-replay.ts`), so the project
   * lands where `main` left it, through stage 6. A replay that stops short
   * is reported as `landing.stopped`, not thrown: the project is imported
   * either way.
   */
  importProject: async (raw: unknown): Promise<ImportOutcome> => {
    if (!isLegacyBundle(raw)) {
      return asWorkspaceOwner(async (transport, workspaceTenantId) => {
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
            // The project's own tenant (#29): `sb.projectId` names it.
            const artifact = await installerCreateArtifact(transport, sb.projectId as string, {
              title,
              content,
              metadata: { sb },
            });
            return { id: artifact.id };
          },
        });
      });
    }
    const imported = await asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const bundle = parseLegacyBundle(raw);
      return importLegacyProject(bundle, {
        createProject: async ({ title, policy }) => {
          const { project } = await installerCreateProject(transport, workspaceTenantId, {
            title,
            slug: projectSlug(),
            policy: policy as ProjectPolicy,
          });
          return { projectId: project.id };
        },
        createArtifact: async ({ title, content, sb }) => {
          const artifact = await installerCreateArtifact(transport, sb.projectId as string, { title, content, metadata: { sb } });
          return { id: artifact.id, version: artifact.version };
        },
        reviseArtifact: async (artifactId, { title, content, sb }) => {
          const artifact = await installerReviseArtifact(transport, sb.projectId as string, artifactId, { title, content, metadata: { sb } });
          return { version: artifact.version };
        },
      });
    });
    const { plan } = imported;
    if (plan.steps.length === 0) {
      return { ...imported, landing: { landed: null, stopped: null, notes: plan.notes } };
    }
    const landing = await api
      .ensureProjectWorkflow(imported.projectId)
      .then(() =>
        replayAdoption(
          { view: (projectId) => api.projectWorkflowView(projectId), decide: (projectId, decision) => api.decide(projectId, decision), now: () => new Date().toISOString() },
          plan,
        ),
      )
      .catch((cause: unknown) => ({ landed: null, stopped: cause instanceof Error ? cause.message : String(cause) }));
    return { ...imported, landing: { ...landing, notes: plan.notes } };
  },
  /**
   * Hands files over with the problem; each becomes a `source_material`
   * artifact version the specialists read. Text/JSON stays on the plain
   * `POST /artifacts` path; anything else (pdf, xlsx, docx, pptx, images)
   * goes through the package's multipart `POST /artifacts/upload`, which
   * mints the artifact itself, then a metadata-only revise stamps `sb` on
   * it — `upload` carries no metadata field of its own. Unlike the deleted
   * host route, a same-named re-upload always starts a fresh artifact
   * rather than a new version of the same one.
   *
   * A zip archive stands for the files inside it (`material-archive.ts`):
   * those are what get attached, each under its path in the archive.
   */
  attachMaterial: (projectId: string, files: File[]) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const attached = await Promise.all(
        (await expandArchives(files)).map(async (file) => {
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
            const artifact = await installerCreateArtifact(transport, projectId, {
              title: file.name,
              content,
              metadata: { sb },
            });
            return { nodeId: artifact.id, name: file.name, mediaType, sizeBytes: file.size };
          }
          const uploaded = await uploadArtifactFile(projectId, file);
          try {
            await installerReviseArtifact(transport, projectId, uploaded.id, { metadata: { sb } });
          } catch (cause) {
            // Unstamped, the upload is invisible to the project forever (no
            // `sb.projectId` for the fold to match) — archive it rather than
            // leaving an orphan artifact behind, then surface the original
            // failure.
            await installerArchiveArtifact(transport, projectId, uploaded.id).catch(() => {});
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
          const readingFailed = await installerCreateArtifact(transport, projectId, {
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
    asWorkspaceOwner((transport, workspaceTenantId): Promise<TemplateTheme | null> => roleStyleGuideTheme(transport, workspaceTenantId, role)),
  /**
   * The design documents of one scope (#246): the workspace's, which every
   * project's decks are built against unless a project turns them off, or
   * one project's own. Newest first.
   */
  designDocuments: (projectId?: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => ({
      documents: await listDesignDocuments(transport, projectId ?? workspaceTenantId, projectId ? "project" : "workspace"),
    })),
  /**
   * Adds design documents to the workspace or to one project, the way
   * `attachMaterial` attaches a file: text as a text artifact; a PDF or
   * PowerPoint through the multipart route, stamped `sb`, with a companion
   * reading holding its text. A PowerPoint's theme is read here, once, and
   * saved on its stamp, so drawing a deck never downloads the file again.
   * A file of another kind is refused by name before anything is written.
   */
  addDesignDocuments: (files: File[], projectId?: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const tenantId = projectId ?? workspaceTenantId;
      for (const file of files) {
        const refusal = designDocumentRefusal(file.name, file.type || "");
        if (refusal) {
          throw new ApiFailure({ code: "unsupported_type", message: refusal, correlationId: "-", retryable: false });
        }
      }
      const added = await Promise.all(
        files.map(async (file) => {
          const format = designDocumentFormat(file.name, file.type || "")!;
          const mediaType = file.type || (format === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : format === "pdf" ? "application/pdf" : "text/plain");
          const bytes = new Uint8Array(await file.arrayBuffer());
          const provenance = { producer: "human" as const };
          if (format === "text") {
            const artifact = await installerCreateArtifact(transport, tenantId, {
              title: file.name,
              content: new TextDecoder("utf-8").decode(bytes),
              metadata: { sb: { kind: DECK_DESIGN_DOCUMENT_KIND, variant: file.name, mediaType, sourceVersionIds: [], provenance } },
            });
            return { id: artifact.id, name: file.name, read: true };
          }
          // The look, read once here: a PowerPoint's theme from its XML, a
          // PDF's page ratio and colours from its first pages drawn small
          // (#254). Neither failing stops the add; the stamp just carries none.
          const theme = format === "pptx" ? await readTemplateTheme(bytes).catch(() => null) : await pdfLook(bytes).catch(() => null);
          // The text, as `attachMaterial` reads a file: what the presentation
          // creator is handed. Reading failing is not an add failure — the
          // companion says so instead — and a picture-only file is stamped as
          // carrying no text, so the list says so rather than pretending.
          const readingText = await readMaterial({ name: file.name, mediaType, bytes })
            .then((result) => result.text)
            .catch((cause) => `(Could not read ${file.name}: ${cause instanceof Error ? cause.message : String(cause)}.)`);
          const textRead = readingHasText(readingText);
          const uploaded = await uploadArtifactFile(tenantId, file);
          try {
            await installerReviseArtifact(transport, tenantId, uploaded.id, {
              metadata: { sb: { kind: DECK_DESIGN_DOCUMENT_KIND, variant: file.name, mediaType, sourceVersionIds: [], provenance, textRead, ...(theme ? { theme } : {}) } },
            });
          } catch (cause) {
            await installerArchiveArtifact(transport, tenantId, uploaded.id).catch(() => {});
            throw cause;
          }
          // The companion reading. Its own write failing is not an add
          // failure either: the file is kept, and the list shows it as not
          // read rather than pretending it was.
          const read = await installerCreateArtifact(transport, tenantId, {
            title: `${file.name} (reading)`,
            content: readingText,
            metadata: {
              sb: { kind: DECK_DESIGN_READING_KIND, variant: file.name, sourceVersionIds: [uploaded.id], provenance, mediaType: "text/plain" },
            },
          })
            .then(() => true)
            .catch(() => false);
          return { id: uploaded.id, name: file.name, read };
        }),
      );
      return { added };
    }),
  /** Archives a design document and the reading kept beside it. */
  removeDesignDocument: (documentId: string, projectId?: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const tenantId = projectId ?? workspaceTenantId;
      const readings = readingIdsFor(await listArtifacts(transport, tenantId), documentId);
      await installerArchiveArtifact(transport, tenantId, documentId);
      await Promise.all(readings.map((id) => installerArchiveArtifact(transport, tenantId, id).catch(() => {})));
      return { removed: documentId };
    }),
  /** One project's deck settings — today, whether the workspace's design documents apply to it. */
  projectDeckSettings: (projectId: string) =>
    asWorkspaceOwner(async (transport) => (await installerRequireProject(transport, projectId)).deckSettings),
  setProjectDeckSettings: (projectId: string, settings: { useWorkspaceDesignDocuments: boolean }) =>
    asWorkspaceOwner(async (transport) => (await installerUpdateProject(transport, projectId, { deckSettings: settings })).deckSettings),
  /**
   * What one stakeholder's deck in one project is drafted and drawn against
   * (#246). The theme: the role's mapped style guide when there is one,
   * else the first PowerPoint among the design documents that apply — the
   * project's own before the workspace's — else null for the built-in look.
   * The guidelines: the role's saved guidance and every applying document's
   * text, as the block `packageRequest` hands the presentation creator.
   */
  deckBrief: (projectId: string, role: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId): Promise<DeckBrief> => {
      const [project, workspace, own, preferences, styleGuide] = await Promise.all([
        installerRequireProject(transport, projectId),
        listDesignDocuments(transport, workspaceTenantId, "workspace"),
        listDesignDocuments(transport, projectId, "project"),
        loadDeckDesigns(transport).catch(() => ({}) as Record<string, unknown>),
        roleStyleGuideTheme(transport, workspaceTenantId, role),
      ]);
      const documents = effectiveDesignDocuments({ workspace, project: own, settings: project.deckSettings });
      const readings = await Promise.all(
        documents
          // A picture-only file has no text worth handing over; its look still counts below.
          .filter((document) => document.readingId !== null && document.textRead)
          .map(async (document) => {
            const tenantId = document.scope === "project" ? projectId : workspaceTenantId;
            const artifact = await installerGetArtifact(transport, tenantId, document.readingId!);
            return { name: document.name, scope: document.scope, text: artifact?.content ?? "" };
          }),
      );
      return {
        theme: styleGuide ?? designThemeOf(documents),
        guidelines: designGuidelinesBlock(readings, guidanceFor(role, preferences)),
        documents: documents.map((document) => document.name),
      };
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
    asWorkspaceOwner(async (transport) => {
      const kind = STAGE_DRAFT_KIND[stage];
      if (!kind) {
        throw new ApiFailure({
          code: "validation_failed",
          message: `Stage ${stage} has no draft document to approve.`,
          correlationId: "-",
          retryable: false,
        });
      }
      return persistDraftOfKind(transport, projectId, {
        stage,
        kind,
        content,
        sourceVersionIds,
        title: `Stage ${stage} draft`,
        // Stamped with the stage's own specialist so `reviewableArtifact`
        // recognises the write as the draft's persisted form: found on
        // the next load instead of persisted again, and superseded only
        // by a draft the specialist sends later. Stage 8 is left
        // unstamped on purpose -- its reviewable artifact is the archive
        // the host packaged, recorded by the build panel with producer
        // "host", never a persisted reply.
        ...(stage === 8 ? {} : { agentRole: agentFor(stage as Stage).id }),
        ...(target ? { target } : {}),
      });
    }),
  /**
   * Records stage 6's product requirements document (#328): the
   * requirements author's reply, which used to live only in its mail
   * thread and so was gone from the strip, the download and the page after
   * a reload. One lineage per project; a later reply supersedes.
   */
  persistProductRequirements: (projectId: string, content: string) =>
    asWorkspaceOwner((transport) =>
      persistDraftOfKind(transport, projectId, {
        stage: 6,
        kind: "product_requirements",
        content,
        sourceVersionIds: [],
        title: "Product requirements",
        agentRole: stage6RoleFor(STAGE6_REQUIREMENTS_ROLE_KEY).id,
      }),
    ),
  /**
   * Records one panel review of the build plan (#334): the senior
   * engineer's reply as the project's engineering_review document for that
   * reviewer, one lineage per reviewer. The strip shows it and the
   * documents download carries it.
   */
  persistEngineeringReview: (projectId: string, roleKey: string, reviewer: string, content: string) =>
    api.persistPanelReview(projectId, 6, roleKey, reviewer, content),
  /** The stage 6 role's live deployment, read only (#328): what to read a reply back from, never a deploy. */
  stage6RoleAgentStatus: (projectId: string, roleKey: string): Promise<SpecialistDeploymentStatus | null> => api.stageRoleAgentStatus(projectId, 6, roleKey),
  /** A stage's companion role's live deployment, read only (#341). */
  stageRoleAgentStatus: (projectId: string, stage: 6 | 8, roleKey: string): Promise<SpecialistDeploymentStatus | null> =>
    asWorkspaceOwner(async (transport) => stageSpecialistStatus(transport, projectId, stage as Stage, roleKey, await hostSidecar())),
  /**
   * Records one panel review (#334, #341): at stage 6 the plan's
   * engineering_review, at stage 8 the build's build_review, one lineage per
   * reviewer, the reviewer's role in its provenance.
   */
  persistPanelReview: (projectId: string, stage: 6 | 8, roleKey: string, reviewer: string, content: string) =>
    asWorkspaceOwner((transport) =>
      persistDraftOfKind(transport, projectId, {
        stage,
        kind: stage === 8 ? "build_review" : "engineering_review",
        variant: reviewer,
        content,
        sourceVersionIds: [],
        title: `${reviewer} review`,
        agentRole: stage6RoleFor(roleKey).id,
      }),
    ),
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
  /**
   * The document a drafting stage's specialist keeps with the artifact tools:
   * the newest artifact of the stage's kind that a workflow run wrote in the
   * project's tenant. Null when there is none yet. A read that fails throws,
   * so the workspace can say the document is unavailable rather than fall
   * back to an older draft.
   */
  stageWorkArtifact: async (
    tenantId: string,
    kind: string,
  ): Promise<{ id: string; version: number; content: string } | null> => {
    const transport = createHubTransport();
    const written = (await listArtifacts(transport, tenantId, { kind }))
      .filter((item) => item.archivedAt === null && item.source.origin === "workflow")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (!written) return null;
    const artifact = await installerGetArtifact(transport, tenantId, written.id);
    if (!artifact) throw new Error(`The stage document ${written.id} could not be read.`);
    return { id: artifact.id, version: artifact.version, content: artifact.content };
  },
  artifactContent: async (tenantId: string, nodeId: string): Promise<{ content: string; version?: number }> => {
    // The project's own tenant, else the workspace for an older project's
    // artifact still recorded there (#29, `findArtifact`).
    const found = await findArtifact(createHubTransport(), tenantId, nodeId);
    if (!found) return { content: "" };
    const { version } = found.artifact;
    const uploadId = (found.artifact.source as { upload?: { id?: unknown } }).upload?.id;
    if (typeof uploadId !== "string") return { content: found.artifact.content, version };
    return { content: await downloadUploadedArtifact(found.tenantId, nodeId), version };
  },
  /** The workspace's languages (#411); American English both ways until set. */
  languageSettings: (): Promise<LanguageSettings> =>
    asWorkspaceOwner((transport, workspaceTenantId) => readLanguageSettings(transport, workspaceTenantId)),
  saveLanguageSetting: <K extends keyof LanguageSettings>(key: K, value: LanguageSettings[K]): Promise<LanguageSettings> =>
    asWorkspaceOwner((transport, workspaceTenantId) => installerSaveLanguageSettings(transport, workspaceTenantId, { [key]: value } as Partial<LanguageSettings>)),
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
  /** What "Prune old versions" would archive for `projectId`, without doing it (#297). */
  pruneProjectPlan: (projectId: string): Promise<PrunePlan> =>
    asWorkspaceOwner(async (transport) => {
      const [graph, view] = await Promise.all([artifactGraphFor(transport, projectId), api.projectWorkflowView(projectId)]);
      return prunePlan(graph.nodes, view);
    }),
  /**
   * Archives every version `pruneProjectPlan` says can go (#297): the hub
   * hides an archived version from every listing and read, and deletes
   * nothing. Each version is archived in the tenant that holds it, the
   * project's own or the workspace for an older project's record.
   */
  pruneProjectVersions: (projectId: string): Promise<{ archived: number; kept: number; lineages: number }> =>
    asWorkspaceOwner(async (transport) => {
      const [graph, view] = await Promise.all([artifactGraphFor(transport, projectId), api.projectWorkflowView(projectId)]);
      const plan = prunePlan(graph.nodes, view);
      let archived = 0;
      for (const node of plan.archive) {
        const found = await findArtifact(transport, projectId, node.id);
        if (!found) continue;
        await installerArchiveArtifact(transport, found.tenantId, node.id);
        archived += 1;
      }
      return { archived, kept: plan.keep.length, lineages: plan.lineages };
    }),
  artifactGraph: (projectId: string) =>
    asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const graph = await artifactGraphFor(transport, projectId);
      return { nodes: graph.nodes.map(toArtifactNode), edges: graph.edges };
    }),

  sendStageMail: async (
    tenantId: string,
    agentAddress: string,
    input: { body: string; subject?: string; inReplyTo?: string },
  ): Promise<void> => {
    try {
      // The mailbox the conversation is in is the one the address's domain
      // names: the project's own, or the workspace's for a specialist
      // deployed there before #29 (`mailTenantFor`).
      await sendStageMailViaHub(await mailTenantFor(createHubTransport(), tenantId, agentAddress), agentAddress, input);
    } catch (cause) {
      installerFailure(cause);
    }
  },
  readStageThread: async (tenantId: string, agentAddresses: string[]): Promise<ChatMessage[]> => {
    try {
      // Read from each mailbox the addresses' domains name (see `sendStageMail`),
      // merged oldest first: a stage's thread can span a legacy workspace
      // deployment and its revival in the project tenant.
      const groups = await addressesByMailTenant(createHubTransport(), tenantId, agentAddresses);
      const threads = await Promise.all(
        [...groups.entries()].map(([mailTenantId, addresses]) => readStageThreadViaHub(mailTenantId, addresses)),
      );
      return threads.flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
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
      const artifacts = await listProjectArtifacts(transport, projectId, { kind: WITHDRAWN_TURNS_KIND });
      const existing = artifacts.find(
        (artifact) =>
          artifact.archivedAt === null &&
          (artifact.metadata as { sb?: Record<string, unknown> } | null)?.sb?.["projectId"] === projectId,
      );
      const mark: WithdrawnMark = { messageId: entry.messageId, stage: entry.stage, at: new Date().toISOString() };
      if (existing) {
        // Revised where it is: an older project's marker can still sit in the workspace tenant (#29).
        const found = await findArtifact(transport, tenantId, existing.id);
        const marks = [...parseWithdrawnTurns(found?.artifact.content ?? null), mark];
        await installerReviseArtifact(transport, found?.tenantId ?? tenantId, existing.id, { content: withdrawnTurnsContent(marks) });
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
            sourceVersionIds: [],
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
        if (await memoStillLive(projectId, stage as Stage, undefined, deployment)) return deployment;
        ensureStageAgentCalls.delete(key);
        return api.ensureStageAgent(projectId, stage);
      });
    }
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await readyToDeploy(transport, workspaceTenantId, projectId);
      // Mailing a deployment whose sidecar is not placed yet loses the
      // message: the run never starts and the stage waits on a reply that
      // cannot come. Wait for the hub to call it deployed first.
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        projectId,
        stage as Stage,
        specialistHubOrigin(),
        // Every stage's own specialist carries the artifact tools and their
        // hub credential: a drafting stage writes its document with them,
        // and any stage reads the documents a person attaches.
        true,
        undefined,
        await localizedRole(transport, workspaceTenantId, agentFor(stage as Stage)),
      );
      const placement = await waitForDeploymentPlacement(transport, deployment.tenantId, deployment.deploymentId);
      if (placement.outcome !== "placed") throw placementFailure(`the stage ${stage} specialist`, placement);
      return deployment;
    });
    call.catch(() => ensureStageAgentCalls.delete(key));
    ensureStageAgentCalls.set(key, call);
    return call;
  },
  /**
   * CL-8899 "Switch model": deploys a new specialist for `projectId`'s
   * current stage whose inference chain leads with `offeringId`, and hands
   * back its address. The old deployment stays live (the hub cannot stop a
   * run, INTR-454); `switchSpecialistDeployment` records the new one as the
   * durable switch target (`resolveLiveDeployment`, `project-tenant.ts`) so
   * every subsequent read of this asset -- including `ensureStageAgent`'s
   * own memo, primed here so an immediate re-render sees the switch without
   * waiting on `useStageAgent`'s poll -- resolves to it, while
   * `pickDeployment` itself stays oldest-wins for every other caller.
   */
  switchStageAgent: (projectId: string, stage: number, offeringId: string): Promise<SpecialistDeployment> => {
    const key = `${projectId}:${stage}`;
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await readyToDeploy(transport, workspaceTenantId, projectId);
      const deployment = await switchSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        projectId,
        stage as Stage,
        specialistHubOrigin(),
        offeringId,
        true,
      );
      const placement = await waitForDeploymentPlacement(transport, deployment.tenantId, deployment.deploymentId);
      if (placement.outcome !== "placed") throw placementFailure(`the stage ${stage} specialist on the new model`, placement);
      activeModelCacheClear();
      return deployment;
    });
    ensureStageAgentCalls.set(key, call);
    call.catch(() => ensureStageAgentCalls.delete(key));
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
    if (pending) {
      return pending.then(async (deployment) => {
        if (await memoStillLive(projectId, 1 as Stage, BRIEF_EVALUATOR_ROLE_KEY, deployment)) return deployment;
        ensureStage1EvaluatorCalls.delete(projectId);
        return api.ensureStage1EvaluatorAgent(projectId);
      });
    }
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await readyToDeploy(transport, workspaceTenantId, projectId);
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        projectId,
        1 as Stage,
        specialistHubOrigin(),
        false,
        BRIEF_EVALUATOR_ROLE_KEY,
        await localizedRole(transport, workspaceTenantId, BRIEF_EVALUATOR_ROLE),
      );
      const placement = await waitForDeploymentPlacement(transport, deployment.tenantId, deployment.deploymentId);
      if (placement.outcome !== "placed") throw placementFailure("the stage 1 brief evaluator", placement);
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
    if (pending) {
      return pending.then(async (deployment) => {
        if (await memoStillLive(projectId, 1 as Stage, PRODUCT_GUIDE_ROLE_KEY, deployment)) return deployment;
        ensureGuideAgentCalls.delete(projectId);
        return api.ensureGuideAgent(projectId);
      });
    }
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await readyToDeploy(transport, workspaceTenantId, projectId);
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        projectId,
        1 as Stage,
        specialistHubOrigin(),
        false,
        PRODUCT_GUIDE_ROLE_KEY,
        await localizedRole(transport, workspaceTenantId, PRODUCT_GUIDE_ROLE),
      );
      const placement = await waitForDeploymentPlacement(transport, deployment.tenantId, deployment.deploymentId);
      if (placement.outcome !== "placed") throw placementFailure("the product guide", placement);
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
  ensureStage6RoleAgent: (projectId: string, roleKey: string): Promise<SpecialistDeployment> => api.ensureStageRoleAgent(projectId, 6, roleKey),
  /**
   * Deploys (or finds) one of a stage's companion roles -- stage 6's
   * requirements author and panel, stage 8's panel (#341) -- and waits
   * for it to be placed. Memoised per project, stage and role for as long
   * as the deployment it remembers is still the live one.
   */
  ensureStageRoleAgent: (projectId: string, stage: 6 | 8, roleKey: string): Promise<SpecialistDeployment> => {
    const key = `${projectId}:${String(stage)}:${roleKey}`;
    const pending = ensureStage6RoleAgentCalls.get(key);
    if (pending) {
      return pending.then(async (deployment) => {
        if (await memoStillLive(projectId, stage as Stage, roleKey, deployment)) return deployment;
        ensureStage6RoleAgentCalls.delete(key);
        return api.ensureStageRoleAgent(projectId, stage, roleKey);
      });
    }
    const call = asWorkspaceOwner(async (transport, workspaceTenantId) => {
      const status = await readyToDeploy(transport, workspaceTenantId, projectId);
      const deployment = await ensureSpecialistDeployment(
        transport,
        sidecarCapabilityOf(status),
        await lifecycleClosureSource(),
        lifecycleGitPush,
        projectId,
        stage as Stage,
        specialistHubOrigin(),
        false,
        roleKey,
        await localizedRole(transport, workspaceTenantId, stage6RoleFor(roleKey)),
      );
      const placement = await waitForDeploymentPlacement(transport, deployment.tenantId, deployment.deploymentId);
      if (placement.outcome !== "placed") throw placementFailure(`the ${roleKey} specialist`, placement);
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
    asWorkspaceOwner(async (transport) => stageSpecialistStatus(transport, projectId, stage as Stage, undefined, await hostSidecar())),
  /**
   * What `projectId`'s stage-`stage` specialist is doing, read from its run
   * (#445): working, parked for its next mail, ended, or unknown when the
   * run or its log cannot be read. The deployment's top-level run is the
   * specialist's one manual run; with several (a redeploy's history), the
   * one whose last word is newest speaks for it, a live run before an ended
   * one (`newestRun`), whatever order the hub lists them in.
   */
  stageSpecialistRunState: (projectId: string, stage: number): Promise<SpecialistRun> =>
    asWorkspaceOwner(async (transport) => {
      const status = await stageSpecialistStatus(transport, projectId, stage as Stage, undefined, await hostSidecar());
      if (!status || ENDED_DEPLOYMENT_STATUSES.has(status.status)) return UNKNOWN_RUN;
      const workflows = workflowsFor(transport, status.tenantId);
      const runIds = topLevelRunIds(await workflows.runs(status.deploymentId));
      const runs = await Promise.all(runIds.map(async (runId) => runStateOf((await workflows.runEvents(status.deploymentId, runId)).events)));
      return newestRun(runs);
    }).catch(() => UNKNOWN_RUN),
  /**
   * Every address `projectId`'s stage-`stage` specialist has ever run at --
   * the input `useStageThread`'s merge needs so a redeploy (restart, model
   * switch) never empties a stage's chat: earlier mail lives under earlier
   * deployments' addresses, not the live one alone (CL-8927), and it is what
   * `useModelHandoff` (CL-8899) compares the live address against to tell a
   * redeploy-with-history from a genuinely new stage.
   */
  stageAgentAddresses: (projectId: string, stage: number): Promise<string[]> =>
    asWorkspaceOwner((transport) => stageSpecialistAddresses(transport, projectId, stage as Stage)),
  /**
   * Makes sure `projectId`'s process authority (CL-8721/CL-8687) is deployed
   * and its one manual run triggered, the same ensure-and-reuse discipline
   * `ensureStageAgent` uses for a stage specialist: memoised per project so
   * two callers mounting at once share the in-flight deploy instead of
   * racing to create it twice. Every stage 1..`LAST_STAGE` is authorized for
   * the signed-in workspace owner -- the only principal that can approve
   * today; a future multi-principal policy is a later change to this one
   * call site.
   *
   * A run on other code than the interface currently ships is replaced and
   * its decisions replayed through the new code (#51); the answer then
   * carries a `replay`, whose `refused` names any decision the new rules
   * turned down, for the page to show.
   */
  /**
   * Rebuilds the project's run from its recorded decisions (#299): a fresh
   * deployment, every recorded signal sent again, whatever is live now. For
   * when the last state is not to be trusted. The memo is dropped first so
   * this and every later call see the rebuilt run.
   */
  repairProjectWorkflow: (projectId: string): Promise<EnsuredProjectWorkflow> => {
    ensureProjectWorkflowCalls.delete(projectId);
    const call = ensureProjectWorkflowWith(projectId, { repair: true });
    ensureProjectWorkflowCalls.set(projectId, call);
    call.catch(() => ensureProjectWorkflowCalls.delete(projectId));
    return call;
  },
  ensureProjectWorkflow: (projectId: string): Promise<EnsuredProjectWorkflow> => {
    const pending = ensureProjectWorkflowCalls.get(projectId);
    if (pending) return pending;
    const call = ensureProjectWorkflowWith(projectId, {});
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
      const ref = await resolveProjectWorkflowRef(transport, projectId);
      if (!ref) return null;
      const view = await loadProjectWorkflowView(transport, ref);
      if (view.generatedTitle) await adoptGeneratedTitle(transport, projectId, view.generatedTitle);
      return view;
    }),
  /**
   * Delivers one decision as the loop's `project.decision` signal,
   * `signalId = decision.decisionId`. A repeat of the exact same decision is
   * a no-op success (the reducer already dedups on `decisionId`, and the hub
   * itself treats a byte-identical retry as accepted); a DIFFERENT payload
   * under an already-used `decisionId` is the hub's `signal_id_conflict`
   * (409), surfaced as a hard error rather than swallowed.
   *
   * The `ensureProjectWorkflow` in-session memo, when there is one, wins:
   * it is the only path that waits for the hub's own replacement of a dead
   * deployment and replays that project's history onto it
   * (`projectRunState`/`catchUp`), so it is the only ref guaranteed live and
   * caught up. `useWorkflowView`'s attach-first read still starts an
   * `ensureProjectWorkflow` call in the background every mount, so in
   * practice the memo is populated (or in flight, in which case this awaits
   * it) almost immediately -- the plain read-only fallback
   * (`resolveProjectWorkflowRef`, the same cheap lookup `projectWorkflowView`
   * uses) only matters in the narrow window before that background call has
   * had a chance to run, and can itself return a dead deployment's ref
   * (`projectRunState` deliberately does, rather than flash the view back to
   * stage 1) -- acceptable there only because the hub's own `signal_id_conflict`
   * / not-found response on a dead deployment is a hard error either way, not
   * a silently wrong success.
   */
  decide: (projectId: string, decision: Record<string, unknown>): Promise<{ ok: true }> =>
    asWorkspaceOwner(async (transport) => {
      const ref =
        (await ensureProjectWorkflowCalls.get(projectId)) ??
        (await resolveProjectWorkflowRef(transport, projectId));
      if (!ref) throw new Error(`project workflow for ${projectId} has not been deployed yet`);
      // A `signal_id_conflict` (409, a different payload under a reused
      // decisionId) is a hard error, not swallowed here -- it propagates as
      // an `ApiError` through `asWorkspaceOwner`'s normal failure path. A
      // byte-identical retry is accepted by the hub as a no-op, so it never
      // reaches this catch at all.
      //
      // A fresh run names its project before its loop first parks, and a
      // decision delivered before that park kills the run.
      await waitForPark(transport, ref);
      // Signalled in the tenant the ref names (#163): the project's own for
      // a deployment made since #29, the workspace for a legacy one still
      // live there. The workspace's route answers 404 for a project-tenant
      // deployment, which silently left every review unopened.
      await workflowsFor(transport, ref.tenantId).signal(ref.deploymentId, {
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
    asWorkspaceOwner((transport) => openingOf(transport, projectId)),
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
   * audience's package rather than the stage's single document, and
   * `provenance.agentRole` the same way every other stage's written
   * artifact is -- `reviewableArtifact` (`stage-approval.ts`) reads this,
   * not `producer`, to find stage 5's reviewable material (CL-8892).
   */
  persistAudiencePackage: (projectId: string, audience: string, content: string) =>
    asWorkspaceOwner(async (transport) => {
      // A package written again supersedes the stakeholder's current head,
      // the way `persistStageDraft` chains a stage's draft -- without it both
      // stayed live and the page showed the stakeholder twice (#122). Best
      // effort, as there: a graph read that fails never blocks the write.
      const previousHead = await artifactGraphFor(transport, projectId)
        .then(
          (graph) =>
            graph.nodes
              .filter(
                (node) =>
                  node.stage === 5 &&
                  node.kind === STAGE_DRAFT_KIND[5] &&
                  node.variant === audience &&
                  node.supersededByNodeId === null,
              )
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0],
        )
        .catch(() => undefined);
      const artifact = await installerCreateArtifact(transport, projectId, {
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
            provenance: { producer: "agent" as const, agentRole: STAGE_5_PACKAGE_ROLE.id },
            ...(previousHead ? { supersedes: previousHead.id } : {}),
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
   * Records the archive the host packaged from a build attempt's directory
   * (`POST /projects/:id/build/attempts/:n/package`) as the stage's real
   * `build_evidence` artifact — bytes and media type, not the chat text
   * `persistStageDraft` would otherwise write — and its delivery manifest
   * beside it. The provenance says what happened: produced by the host,
   * for the attempt the manifest names; no specialist made it. That is
   * what `reviewableArtifact` accepts as stage 8's reviewable node.
   */
  persistBuildEvidence: (
    projectId: string,
    bundle: { fileName: string; mediaType: string; dataUri: string; sizeBytes: number; manifest?: { attempt: string } & Record<string, unknown> },
    sourceVersionIds: string[] = [],
  ) =>
    asWorkspaceOwner(async (transport) => {
      // The attempt the archive and its manifest share, so stage 9 finds the
      // manifest as the archive's companion (`manifestCompanionOf`).
      const variant = bundle.manifest?.attempt ?? null;
      const attemptNumber = /^attempt-(\d+)$/.exec(variant ?? "")?.[1];
      const provenance = { producer: "host" as const, ...(attemptNumber ? { attempt: Number(attemptNumber) } : {}) };
      const artifact = await installerCreateArtifact(transport, projectId, {
        title: bundle.fileName,
        content: bundle.dataUri,
        metadata: {
          sb: {
            projectId,
            kind: STAGE_DRAFT_KIND[8]!,
            stage: 8,
            mediaType: bundle.mediaType,
            ...(variant === null ? {} : { variant }),
            sourceVersionIds,
            provenance,
          },
        },
      });
      // The manifest comes back inline with the archive, verification and
      // all (#129), and is written beside it.
      if (bundle.manifest) {
        await installerCreateArtifact(transport, projectId, {
          title: `${bundle.fileName.replace(/\.tar\.gz$/, "")}-manifest.json`,
          content: JSON.stringify(bundle.manifest),
          metadata: {
            sb: {
              projectId,
              kind: DELIVERY_MANIFEST_KIND,
              stage: 8,
              mediaType: "application/json",
              ...(variant === null ? {} : { variant }),
              sourceVersionIds: [artifact.id],
              provenance,
            },
          },
        });
      }
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

/** The busy strip's line for what the ensure step is doing (#295). */
export function ensureProgressLabel(progress: EnsureProgress): string {
  switch (progress.phase) {
    case "waiting":
      return "Waiting for the hub to place the project's workflow";
    case "deploying":
      return "Deploying the project's workflow";
    case "replaying":
      return progress.total > 0
        ? `Replaying decision ${String(Math.min(progress.done + 1, progress.total))} of ${String(progress.total)} onto the project's workflow`
        : "Starting the project's workflow";
  }
}
