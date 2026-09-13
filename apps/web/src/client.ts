/**
 * The API client.
 *
 * The one place the interface talks to the host. Every call goes through
 * `request`, so an error contract change is a change here and nowhere else.
 * Clients read and command; they never write persistence.
 */
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
  notifiedAt: string | null;
  notifyError: string | null;
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
  /** Whose move it is on the current stage. */
  turn: "writing" | "question" | "approve" | "idle";
  question?: { ordinal: number; remaining: number };
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
  provenance: { producer: string; agentRole?: string; providerId?: string; model?: string };
};

/** "What is happening right now", resolved from the runtime executor's own step. */
export type RunActivity = {
  headline: string;
  stepId: string | null;
  parked: boolean;
  signalName: string | null;
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
  /** Only ever set for the currently active run; `null` for run history. */
  activity: RunActivity | null;
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
  };
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

/** Ollama's default, matching how corbits-code stores the local provider. */
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";

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

/** A passage the person selected before writing. */
export type Quote = { quote: string };

export type StageTurn = {
  id: string;
  role: "human" | "specialist";
  body: string;
  quotes: Quote[];
  resultNodeId: string | null;
  createdAt: string;
};

/** The stage-1 brief evaluator's verdict. Advisory only — nothing gates on it. */
export type Evaluation = { ready: boolean; notes: string[] };

export type InstallState = {
  deployment?: { status: string; detail: string };
  installed: boolean;
  appVersion: string;
  stale: string[];
  missing: string[];
  detail: string;
};

export const api = {
  status: () => request<HostStatus>("/status"),
  installState: () => request<InstallState>("/install"),
  install: () => post<InstallState>("/install"),
  agents: () => request<{ agents: { id: string; title: string; mission: string; stages: number[]; boundary: string }[] }>("/agents"),
  providers: () =>
    request<{
      providers: Provider[];
      apiKeyProviders: { providerId: string; label: string; needsBaseUrl: boolean }[];
      oauthCandidates: { providerId: string; label: string; redirectUri: string }[];
    }>("/providers"),
  connectProvider: (payload: unknown) => post<{ provider: Provider }>("/providers", payload),
  startOAuth: (providerId: string) =>
    post<{ authorizeUrl: string; browserOpened: boolean; detail: string }>(
      `/providers/oauth/${providerId}/start`,
    ),
  finishOAuth: () => post<{ provider: Provider }>("/providers/oauth/finish"),
  cancelOAuth: () => post<{ cancelled: true }>("/providers/oauth/cancel"),
  setProviderOrder: (providerIds: string[]) =>
    request<{ providers: Provider[] }>("/providers/order", {
      method: "PUT",
      body: JSON.stringify({ providerIds }),
    }),
  refreshModels: (providerId: string) =>
    post<{ provider: Provider }>(`/providers/${providerId}/refresh`),
  selectModel: (providerId: string, model: string) =>
    request<{ provider: Provider }>(`/providers/${providerId}/model`, {
      method: "PUT",
      body: JSON.stringify({ model }),
    }),
  disconnectProvider: (providerId: string) =>
    request<{ ok: true }>(`/providers/${providerId}`, { method: "DELETE" }),
  decisions: () => request<{ decisions: Wait[] }>("/decisions"),
  projects: () => request<{ projects: ProjectSummary[] }>("/projects"),
  createProject: (payload: unknown) =>
    post<{ projectId: string; runId: string }>("/projects", payload),
  project: (projectId: string) => request<ProjectDetail>(`/projects/${projectId}`),
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
  /** The stakeholders stage 5 writes for, and the roles one may hold. */
  stakeholders: (projectId: string) =>
    request<{ audiences: { name: string; role: string }[]; audienceQuorum: number; roles: string[] }>(
      `/projects/${projectId}/stakeholders`,
    ),
  setStakeholders: (projectId: string, payload: { audiences: { name: string; role: string }[]; audienceQuorum: number }) =>
    request<{ audiences: { name: string; role: string }[]; audienceQuorum: number; roles: string[] }>(
      `/projects/${projectId}/stakeholders`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),
  updateProject: (projectId: string, payload: { title?: string; archived?: boolean }) =>
    request<{ ok: true }>(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteProject: (projectId: string) =>
    request<{ ok: true }>(`/projects/${projectId}`, { method: "DELETE" }),
  artifact: (nodeId: string) =>
    request<{ node: ArtifactNode; content: string }>(`/artifacts/${nodeId}`),
  /** Keeps a PowerPoint as a stakeholder role's style guide; its theme is read back. */
  uploadDeckTemplate: (role: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return requestForm<{ role: string; theme: Record<string, string | number> }>(`/deck-settings/${role}/template`, form);
  },
  removeDeckTemplate: (role: string) =>
    request<{ role: string }>(`/deck-settings/${role}/template`, { method: "DELETE" }),
  /** Builds a package's slides when none exist for it yet, then saves them into the Downloads folder; says where. */
  saveSlidesFor: (packageNodeId: string) =>
    post<{ path: string; bytes: number; nodeId: string; built: boolean }>(`/artifacts/${packageNodeId}/slides/save`, {}),
  /** Saves an artifact that is a file (a stakeholder's slides) into the Downloads folder; says where. */
  saveArtifactFile: (nodeId: string) => post<{ path: string; bytes: number }>(`/artifacts/${nodeId}/save`, {}),
  /** Where a design is served as a page of its own, for printing. A path, not a request. */
  printPage: (nodeId: string) => `/api/artifacts/${nodeId}/print`,
  /**
   * Drafts the stage. At stage 5, `audiences` names the stakeholders whose
   * package to write (all when absent). At stage 6, `documents` names which
   * of the requirements and the plan to write (whatever the stage lacks when
   * absent, and always the plan once the requirements exist).
   */
  draft: (
    projectId: string,
    stage: number,
    input: string,
    quotes: Quote[] = [],
    audiences?: string[],
    documents?: ("requirements" | "plan")[],
  ) =>
    post<{
      draft: { nodeId: string; contentHash: string; content: string; agent: string; model: string };
      note?: string;
      /** Stage 5: the stakeholders whose package could not be written, and why. */
      failed?: { audience: string; message: string }[];
      /** Stage 6: the requirements document, when this request wrote it. */
      requirements?: { nodeId: string; contentHash: string; content: string } | null;
    }>(`/projects/${projectId}/stages/${stage}/draft`, {
      input,
      quotes,
      ...(audiences ? { audiences } : {}),
      ...(documents ? { documents } : {}),
    }),
  preferences: () => request<{ preferences: Record<string, unknown> }>("/preferences"),
  setPreference: (key: string, value: unknown) =>
    request<{ key: string }>(`/preferences/${key}`, {
      method: "PUT",
      body: JSON.stringify(value),
    }),
  guidance: (projectId: string) =>
    request<{ guidance: Guidance }>(`/projects/${projectId}/guidance`),
  thread: (projectId: string, stage: number) =>
    request<{
      turns: StageTurn[];
      open: { remaining: number; ordinal: number } | null;
      /** Absent on a hub that does not evaluate this stage yet. */
      evaluation?: Evaluation | null;
    }>(`/projects/${projectId}/stages/${stage}/thread`),
  reply: (
    projectId: string,
    stage: number,
    payload: { message: string; quotes?: Quote[]; revise?: boolean },
  ) =>
    post<{ asked: boolean; remaining: number; note?: string }>(
      `/projects/${projectId}/stages/${stage}/reply`,
      payload,
    ),
  submit: (projectId: string, payload: unknown) =>
    post<CommandOutcome>(`/projects/${projectId}/submit`, payload),
  /** Submit and approve in one, for the person who is the only approver. */
  decide: (projectId: string, payload: unknown) =>
    post<CommandOutcome>(`/projects/${projectId}/decide`, payload),
  command: (projectId: string, command: string, payload: unknown) =>
    post<CommandOutcome>(`/projects/${projectId}/commands/${command}`, payload),
  /**
   * Answers once the run is running. The worker's outcome arrives later, as a
   * `bridge.final` event and the run's state.
   */
  startBuild: (projectId: string, runId: string, expectedRevision?: number) =>
    post<{ run: CommandOutcome }>(`/projects/${projectId}/build/start`, { runId, expectedRevision }),
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
  reviseDesign: (projectId: string, designNodeId: string) =>
    post<{ nodeId: string; content: string; stale: string[] }>(
      `/projects/${projectId}/design/revise`,
      { designNodeId },
    ),
  graph: (projectId: string) =>
    request<{
      nodes: ArtifactNode[];
      edges: { childNodeId: string; sourceNodeId: string }[];
    }>(`/projects/${projectId}/graph`),
  stopHost: () => post<{ stopping: boolean }>("/host/stop"),
};
