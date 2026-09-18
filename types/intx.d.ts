/**
 * Declarations for the vendored Interchange packages.
 *
 * The vendor is upstream's source at a pinned revision and is typechecked in
 * its own repository, not here — compiling ~30 packages inside this program
 * would report errors about code this build does not own and cannot fix without
 * diverging from upstream. The one local change is recorded in
 * `vendor/interchange/PATCHES.md`.
 *
 * What is declared is the surface Solutions Builder actually calls.
 */
declare module "@intx/db" {
  export type InjectedHandle = { readonly handle: unknown; readonly close?: () => Promise<void> };
  export type AnyDb = {
    execute: <T = unknown>(query: unknown) => Promise<{ rows: T[] }>;
    transaction: <T>(callback: (tx: unknown) => Promise<T>) => Promise<T>;
    insert: (table: unknown) => never;
    select: (fields?: unknown) => never;
    query: Record<string, { findFirst: (args?: unknown) => Promise<unknown> }>;
  } & Record<string, unknown>;

  export function createDB(raw: InjectedHandle | Record<string, unknown>): {
    db: AnyDb;
    transaction: AnyDb["transaction"];
    close: () => Promise<void>;
  };
  export type DB = ReturnType<typeof createDB>;

  export function createGrantStore(db: unknown): unknown;
  export function createPrincipalKeyStore(args: {
    db: unknown;
    cipher: unknown;
  }): {
    generate(principalId: string): Promise<string>;
    sign(principalId: string, message: Uint8Array): Promise<Uint8Array>;
    getPublicKey(principalId: string): Promise<string>;
  };
  export function createSidecarAllocationStore(db: unknown): unknown;
  export function createWorkflowRunDispatchStore(db: unknown): unknown;

  /**
   * Best-effort resolution of a signed mail sender's durable public key
   * (hex-encoded), for co-delivery on the run.grants barrier. Never throws;
   * a `null` means the sender has no resolvable key or resolution degraded.
   */
  export function resolveFrameSenderKey(
    db: unknown,
    principalKeyStore: unknown,
    address: string,
  ): Promise<string | null>;
  /**
   * Strict sibling of `resolveFrameSenderKey`: throws on a genuine fault
   * (an ambiguous user address, a keyless principal) instead of degrading to
   * `null`. Used for the reconnect reconciliation's strict resolver.
   */
  export function resolveSenderKey(
    db: unknown,
    principalKeyStore: unknown,
    address: string,
  ): Promise<{ source: "run" | "user"; publicKey: string } | null>;
  export function createPrincipalStore(
    db: unknown,
    keyStore: unknown,
  ): {
    createIfAbsent(row: unknown): Promise<unknown>;
  };

  export type CredentialMaterialEntry = {
    credentialId: string;
    providerKey: string;
    origin: string;
    secret: string;
  };
  /**
   * The platform's single point of decrypt for an inference credential: the
   * tenant-ownership check a deployed workflow's own resolution uses, then
   * the cipher's decrypt at the row this build seals a provider's secret
   * into. `hub-gaps.ts`'s `resolveCredentialSecret` is the one host-side
   * caller — see CL-8076.
   */
  export function resolveInferenceMaterials(
    db: unknown,
    tenantId: string,
    credentialIds: Iterable<string>,
    credentialCipher: unknown,
  ): Promise<CredentialMaterialEntry[]>;

  /**
   * Rebuild a source chain from catalog offering ids. When `principalId` is
   * supplied, an inherited (ancestor) credential additionally requires
   * `credential:<id>/use` on that principal.
   */
  export type OfferingSourceResolution =
    | { ok: true; sources: unknown[] }
    | {
        ok: false;
        reason: "offering_unavailable";
        offeringId: string;
        skip?: { reason: string; provider: string };
      };
  export function resolveSourcesByOfferingIds(
    db: unknown,
    tenantId: string,
    offeringIds: readonly string[],
    credentialCipher: unknown,
    principalId?: string,
  ): Promise<OfferingSourceResolution>;
}

declare module "@intx/db/schema" {
  export const tenant: unknown;
  export const principal: unknown;
  export const grant: unknown;
  export const credential: unknown;
  export const workflowRun: unknown;
  export const workflowDefinition: unknown;
  export const provider: unknown;
  export const model: unknown;
  export const modelProvider: unknown;
  export const modelOffering: unknown;
  export const role: unknown;
  export const principalRole: unknown;
  export const agentRole: unknown;
  /** A launched conversation with a stage specialist — see sessions.ts. */
  export const agentSession: unknown;
  /** A person's or a specialist's turn, as mail — see messages.ts. */
  export const sessionMail: unknown;
  /** One model-inference execution within a session. */
  export const inferenceTurn: unknown;
  /** A part of an inference turn's output; carries free-form `metadata`. */
  export const turnPart: unknown;
}

declare module "@intx/authz" {
  export type Effect = "allow" | "deny" | "ask";
  export type AuthzResult = {
    effect: Effect | null;
    matchingGrants: unknown[];
    resolvedBy: unknown;
  };
  export function authorize(
    store: unknown,
    principalId: string,
    tenantId: string,
    resource: string,
    action: string,
    registry?: unknown,
  ): Promise<AuthzResult>;

  export function timeWindowEvaluator(condition: unknown, context: unknown): boolean;
}

declare module "@intx/crypto" {
  /** SHA-256 digest of a UTF-8 string, over WebCrypto (Node and browser). */
  export function sha256(input: string): Promise<Uint8Array>;
  export function derivePublicKeyBytes(seed: Uint8Array): Promise<Uint8Array>;
  export function createEnvKeyCredentialCipher(key: Uint8Array): unknown;
  export function generateKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  /**
   * Produces a detached OpenPGP signature over `content`, delegating the raw
   * Ed25519 sign operation to `signer` (e.g. `principalKeyStore.sign`) rather
   * than taking the private key directly.
   */
  export function createDetachedSignatureWithSigner(
    content: Uint8Array,
    signer: (input: Uint8Array) => Promise<Uint8Array>,
  ): Promise<Uint8Array>;
}

declare module "@intx/mime" {
  /** The typed header set `assembleMessage` serializes onto a wire message. */
  export type MessageHeaders = {
    from: string;
    to: string[];
    cc: string[] | undefined;
    date: Date;
    messageId: string;
    subject: string | undefined;
    inReplyTo: string | undefined;
    references: string[] | undefined;
    mimeVersion: "1.0";
    interchangeType: string | undefined;
    interchangeCorrelationId: string | undefined;
    interchangeTenantId: string | undefined;
    interchangeAgentId: string | undefined;
    interchangeSessionId: string | undefined;
    interchangeOfferingId: string | undefined;
    interchangeSchemaVersion: string | undefined;
    traceparent: string | undefined;
    tracestate: string | undefined;
  };
  export type ConversationContent = { kind: "conversation"; text: string };
  export function assembleSignedContent(content: ConversationContent): Uint8Array;
  export function assembleMessage(
    headers: MessageHeaders,
    signedContentBytes: Uint8Array,
    signatureBytes: Uint8Array,
  ): Uint8Array;
  export function generateMessageId(address: string): string;
}

declare module "@intx/types/runtime" {
  /** A model-issued tool invocation, as the harness hands it to a `ToolBundle.run`. */
  export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
  /** What a tool call resolves to; `content` rides back to the model as the tool turn. */
  export type ToolResult = {
    callId: string;
    content: string | Record<string, unknown>;
    detail?: unknown;
    isError?: boolean;
    pendingMarker?: { status: "pending"; correlationId: string; expectedFrom?: string };
  };
  /** The tool metadata surfaced to the model: name, description, and a JSON-Schema input shape. */
  export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

  export type ContentBlock = { type: "text"; text: string; signature?: string } & Record<
    string,
    unknown
  >;
  /** One turn of a conversation, in the shape a compactor reads and writes. */
  export type ConversationTurn = {
    role: "user" | "assistant" | "system";
    content: ContentBlock[];
    model?: string;
    timestamp: number;
  };
  export type AssistantTurn = {
    role: "assistant";
    content: ContentBlock[];
    model: string;
    timestamp: number;
  };
  export type TokenUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
  };
  export type InferenceError = {
    category:
      | "retryable"
      | "context_overflow"
      | "credential_failure"
      | "quota_exhausted"
      | "fatal"
      | "aborted"
      | "timeout"
      | "protocol_mismatch";
    message: string;
    statusCode?: number;
    retryAfterMs?: number;
    raw?: unknown;
  };
  export type InferenceOptions = {
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    providerOptions?: Record<string, unknown>;
    inactivityTimeoutMs?: number;
    totalTimeoutMs?: number;
  } & Record<string, unknown>;
  export type InferenceSourceDefaults = Record<string, unknown>;
  export type InferenceSource = {
    id: string;
    provider: string;
    baseURL: string;
    credentialId: string;
    model: string;
    defaults?: InferenceSourceDefaults;
    capabilities?: string[];
    quirks?: Record<string, unknown>;
  };
  export type LastCycleSource = { sourceId: string; provider: string; model: string };
  export type PartialMessage = { text: string } & Record<string, unknown>;

  export type InferenceEvent =
    | { type: "inference.start"; seq: number; data: { model: string } }
    | { type: "inference.text.delta"; seq: number; data: { token: string; partial: PartialMessage } }
    | {
        type: "inference.done";
        seq: number;
        data: { turn: AssistantTurn; usage: TokenUsage; source: LastCycleSource };
      }
    | {
        type: "inference.error";
        seq: number;
        data: { error: InferenceError; partial: PartialMessage };
      };

  export interface StrategyContext {
    readonly trigger: string;
  }
  export type TransformRecord = {
    strategy: string;
    version: string;
    parameters: Record<string, unknown>;
    reason: string;
    decisions: Record<string, unknown>;
  };
  export interface StrategyResult<O> {
    output: O;
    record: TransformRecord;
  }
  export interface ContextStrategy<I, O> {
    readonly name: string;
    readonly version: string;
    apply(input: I, ctx: StrategyContext): Promise<StrategyResult<O>>;
  }
  /** A named compaction strategy, registered on `env.compactors` in `@intx/agent`. */
  export type Compactor = ContextStrategy<ConversationTurn[], ConversationTurn[]>;
}

declare module "@intx/types" {
  export function hexDecode(value: string): Uint8Array;
  export function hexEncode(value: Uint8Array): string;
  // arktype `type()` schemas: the stub only needs `.infer` for the shapes
  // `packages/installer/src/hub.ts` types its catalog-write calls against.
  export const CreateProvider: {
    infer: {
      name: string;
      plugin: string;
      apiBaseUrl?: string;
      authorizationUrl?: string;
      tokenUrl?: string;
      userInfoUrl?: string;
      scopes?: string[];
      metadata?: Record<string, unknown>;
    };
  };
  export const UpdateProvider: {
    infer: {
      name?: string;
      plugin?: string;
      apiBaseUrl?: string | null;
      authorizationUrl?: string | null;
      tokenUrl?: string | null;
      userInfoUrl?: string | null;
      scopes?: string[] | null;
      metadata?: Record<string, unknown> | null;
    };
  };
  export const CreateCredential: {
    infer: {
      providerId: string;
      name: string;
      type: "api_key" | "oauth_token" | "certificate" | "other";
      principalId?: string;
      oauthClientId?: string;
      description?: string;
      secret: string;
      refreshSecret?: string;
      scopes?: string[];
      expiresAt?: string;
      metadata?: Record<string, unknown>;
    };
  };
  export const UpdateCredential: {
    infer: {
      name?: string;
      description?: string;
      secret?: string;
      refreshSecret?: string | null;
      scopes?: string[] | null;
      expiresAt?: string | null;
      status?: "active" | "expired" | "revoked" | "error";
      metadata?: Record<string, unknown>;
    };
  };
  export const CreateModelProvider: {
    infer: {
      name: string;
      plugin: "anthropic" | "openai" | "openai-compatible" | "google-genai";
      baseURL: string;
      credentialId?: string | null;
      walletId?: string | null;
    };
  };
  export const UpdateModelProvider: {
    infer: {
      name?: string;
      baseURL?: string;
      disabled?: boolean;
    };
  };
  export const CreateModelOffering: {
    infer: {
      modelId: string;
      providerId: string;
      priority?: number;
      deploymentTags?: string[];
      capabilities?: string[];
      quirks?: Record<string, unknown>;
    };
  };
  export const UpdateModelOffering: {
    infer: {
      priority?: number;
      deploymentTags?: string[];
      capabilities?: string[];
      quirks?: Record<string, unknown> | null;
      disabled?: boolean;
    };
  };
  /** Splits a `<runId>@<domain>` agent address, or `null` when malformed. */
  export function parseRunAddress(address: string): { runId: string; domain: string } | null;
  export type SidecarCapabilityRule = Record<string, unknown>;
  /**
   * A grant the hub resolves at launch into a materialized grant, against the
   * authority of the definition's creator or the run's invoker.
   */
  export type GrantRequirement = {
    resource: string;
    action: string;
    effect?: "allow" | "deny" | "ask";
    source: "creator" | "invoker";
    conditions?: Record<string, unknown> | null;
  };
}

declare module "@intx/log" {
  export function setup(): Promise<void>;
  export function getLogger(category: string[]): {
    info: (message: string, meta?: unknown) => void;
    error: (message: TemplateStringsArray, ...values: unknown[]) => void;
  };
}

declare module "@intx/inference-catalog" {
  export type CatalogPlugin = "anthropic" | "openai" | "openai-compatible" | "google-genai";
  export type CatalogModelSpec = { canonicalName: string; displayName: string };
  export type CatalogOfferingSpec = {
    model: string;
    priority: number;
    capabilities: string[];
    quirks: Record<string, unknown>;
  };
  export type CatalogProviderSpec = {
    name: string;
    plugin: CatalogPlugin;
    baseURL: string;
    offerings: CatalogOfferingSpec[];
  };
  export const catalogModels: CatalogModelSpec[];
  export const catalogProviders: CatalogProviderSpec[];
}

declare module "@intx/hub-api" {
  import type { Hono } from "hono";
  export function createApp(opts: Record<string, unknown>): Hono;
  export function createAuth(db: unknown): {
    api: { getSession: (args: { headers: Headers }) => Promise<unknown> };
    handler: (request: Request) => Promise<Response>;
  };
  export function createMailTriggeredRunGrantsMaterializer(opts: Record<string, unknown>): unknown;

  export type TenantEnv = { Variables: { tenant: unknown; principal: unknown } };
  export type RequireGrant = (resource: unknown, action: string) => unknown;
  export function createRequireGrant(opts: {
    grantStore: unknown;
    conditionRegistry: Record<string, unknown>;
  }): RequireGrant;
  export function idResource(kind: string, param: string): unknown;
}

declare module "@intx/hub-client" {
  export interface Transport {
    fetch<T>(method: string, path: string, body?: unknown): Promise<T>;
    subscribe(path: string, onEvent: (event: unknown) => void, opts?: { eventName?: string }): () => void;
  }
  export class ApiError extends Error {
    constructor(status: number, code: string, message: string);
    status: number;
    code: string;
  }
  export function createBrowserTransport(): Transport;

  export interface WorkflowDeployment {
    id: string;
    tenantId: string;
    definitionAssetId: string;
    status: string;
    createdAt: string;
  }
  export interface WorkflowRunTrigger {
    runId: string;
    address: string;
    messageId: string;
  }
  export interface WorkflowRunEvent {
    seq: number;
    type: string;
    body: Record<string, unknown>;
  }
  export interface WorkflowRunEvents {
    runId: string;
    events: WorkflowRunEvent[];
  }

  /** Where a workflow definition's bytes come from at apply time (`@intx/types/workflow-sources`). */
  export type WorkflowDefinitionSource =
    | { kind: "registry"; registry: string }
    | {
        kind: "asset";
        assetId: string;
        package: { format: "tarball" } | { format: "source"; commitSha: string; packageName?: string };
      };

  export type TriggerRunAttachment = { mimeType: string; data: string; name?: string };
  export type TriggerWorkflowRunInput = { content: string; attachments?: TriggerRunAttachment[] };
  export type DeployWorkflowInput = {
    source: WorkflowDefinitionSource;
    entry: string;
    sourceOfferingIds: string[];
    defaultSourceOfferingId: string;
    pin?: string;
  };
  export type DeliverSignalInput = { runId: string; signalName: string; signalId: string; payload?: unknown };

  export function listWorkflowDeployments(transport: Transport, tenantId: string): Promise<WorkflowDeployment[]>;
  export function deployWorkflow(
    transport: Transport,
    tenantId: string,
    input: DeployWorkflowInput,
  ): Promise<WorkflowDeployment>;
  export function deliverWorkflowSignal(
    transport: Transport,
    tenantId: string,
    runId: string,
    input: DeliverSignalInput,
  ): Promise<void>;
  export function triggerWorkflowRun(
    transport: Transport,
    tenantId: string,
    runId: string,
    input: TriggerWorkflowRunInput,
  ): Promise<WorkflowRunTrigger>;
  export function listWorkflowRuns(transport: Transport, tenantId: string, runId: string): Promise<string[]>;
  export type RegisterWorkflowDefinitionInput = {
    id?: string;
    name: string;
    description?: string;
    wireHash: string;
    grantRequirements?: readonly unknown[];
  };
  export function registerWorkflowDefinition(
    transport: Transport,
    tenantId: string,
    input: RegisterWorkflowDefinitionInput,
  ): Promise<{ id: string; created: boolean }>;
  export function readWorkflowRunEvents(
    transport: Transport,
    tenantId: string,
    runId: string,
    eventRunId: string,
  ): Promise<WorkflowRunEvents>;

  export const TERMINAL_RUN_EVENT_TYPES: readonly string[];
  export function isTerminalRunEvents(events: WorkflowRunEvent[]): boolean;
  export type AwaitingSignal = { seq: number; signalName: string };
  export function findAwaitingSignal(events: WorkflowRunEvent[]): AwaitingSignal | null;

  export interface RunSession {
    readonly events: WorkflowRunEvent[];
    readonly hydrated: boolean;
    readonly terminal: boolean;
    start(): () => void;
    destroy(): void;
  }
  export function createRunSession(opts: {
    tenantId: string;
    runId: string;
    transport: Transport;
    onChange: () => void;
    onError?: (error: Error) => void;
    pollIntervalMs?: number;
  }): RunSession;
}

declare module "@intx/hub-sessions" {
  export function createAgentRepoStore(opts: Record<string, unknown>): {
    repoStore: unknown;
    writeDeployTree(
      agentId: string,
      content: { systemPrompt: string; toolPackageManifest?: unknown },
    ): Promise<{ commitSha: string }>;
    createDeployPack(
      agentId: string,
    ): Promise<{ pack: Uint8Array; commitSha: string; ref: string }>;
    getSigningPublicKey(): Uint8Array;
  };
  export type AssetService = {
    populateAsset(params: {
      assetId: string;
      ref: string;
      principal: { kind: "hub" } | { kind: "user"; id: string };
      tree: { files: Record<string, string | Uint8Array>; message: string; clearPrefix?: string };
    }): Promise<{ commitSha: string }>;
    readAssetBlob(params: { assetId: string; path: string; ref?: string }): Promise<Uint8Array>;
    listAssetBlobs(params: { assetId: string; dir: string; ref?: string }): Promise<string[]>;
  };
  export function createAssetService(opts: Record<string, unknown>): AssetService;
  export function createEventCollectorRegistry(opts: Record<string, unknown>): unknown;
  export function createHubSessionLookups(opts: Record<string, unknown>): Record<string, unknown>;
  export function createHubSessionOrchestrator(opts: Record<string, unknown>): unknown;
  export function createSessionService(opts: Record<string, unknown>): unknown;
  export type SidecarReconciliationContext = { signal: AbortSignal };
  export function createSidecarAllocationReconciler(opts: Record<string, unknown>): {
    initialize: () => Promise<void>;
    reconcileUntilIdle: () => Promise<void>;
    repairUnscheduledConnections: () => Promise<void>;
    handleDisconnect: (allocated: unknown) => unknown;
    handleConnected: (allocated: unknown) => unknown;
  };
  export function createSidecarPluginRegistry(opts: Record<string, unknown>): unknown;
  export function createSidecarRouter(opts: Record<string, unknown>): Record<string, unknown> & {
    // `on` returns the unsubscribe function the real emitter returns
    // (`sidecar-events.ts`'s `SidecarEventEmitter`); callers that stop
    // watching (a smoke's diagnostic subscription) rely on it.
    events: { on: (name: string, handler: (payload: never) => unknown) => () => void };
  };
  export function createSidecarCredentialResolver(opts: Record<string, unknown>): {
    resolve: (token: string) => Promise<unknown>;
    isCurrent: (...args: unknown[]) => unknown;
  };
  export function createWorkflowAllocationService(opts: Record<string, unknown>): {
    initialize?: () => Promise<void>;
    reconcileReleasingProbes?: () => Promise<void>;
    // The reconciler always calls `onReady` with the allocation row and its
    // reconciliation context; `deployReadyAllocation` reads `reconciliation.signal`
    // on entry, so both arguments are required, not just the allocation.
    deployReadyAllocation: (allocation: unknown, reconciliation: SidecarReconciliationContext) => Promise<void>;
  };
  export function createWorkflowDispatchService(opts: Record<string, unknown>): {
    reconcileUntilIdle: () => Promise<void>;
    requeueForReadyAllocation: (anchorRunId: string) => Promise<void>;
    acknowledge: (args: Record<string, unknown>) => unknown;
  };
  export function pushCredentialReconcile(...args: unknown[]): void;
  export const WORKSPACE_BUILTINS_REGISTRY: string;
  export type SidecarLookups = Record<string, unknown>;
  export type SidecarProvisioner = Record<string, unknown>;
  export type SidecarProvisionerChooser = unknown;
  export type WsHandle = { send: (data: string) => void; close: () => void };
}

declare module "@intx/workflow" {
  export type Primitive = Record<string, unknown>;
  export type Trigger = { type: "manual" } | Record<string, unknown>;

  export interface WorkflowDefinition {
    id: string;
    triggers: readonly Trigger[];
    steps: Record<string, Primitive>;
    stepOrder: readonly string[];
    state?: { schema?: unknown };
  }

  export interface WorkflowConfig {
    id: string;
    trigger?: Trigger;
    triggers?: readonly Trigger[];
    steps: Record<string, Primitive>;
    state?: { schema?: unknown };
  }

  export function defineWorkflow(config: WorkflowConfig): WorkflowDefinition;
  export function gate(opts: Record<string, unknown>): Primitive;
  export function step(opts: Record<string, unknown>): Primitive;
  export function action(opts: Record<string, unknown>): Primitive;
  export function awaitSignal(opts: {
    name: string;
    timeout?: number;
    onTimeout?: string;
    drainBehavior?: "wait" | "drop";
    after?: readonly string[];
  }): Primitive;
  export function escalation(opts: Record<string, unknown>): Primitive;
  /** A bounded repeat of a child definition. §9's stage loop is one of these. */
  export function loop(opts: {
    body: WorkflowDefinition;
    while: string;
    carry: string;
    maxIterations: number;
    onExhausted: string;
    input?: unknown;
    drainBehavior?: "wait" | "drop" | "cancel";
    after?: readonly string[];
  }): Primitive;
  /** A nested definition run as one step of its parent. */
  export function childWorkflow(opts: {
    definition: WorkflowDefinition;
    input?: unknown;
    drainBehavior?: "wait" | "drop" | "cancel";
    after?: readonly string[];
    onFailure?: string;
  }): Primitive;
  /**
   * Long-lived, event-driven section: subscribes to `on` and runs `body`
   * once per occurrence, within the one living workflow run. The chat
   * section is one of these.
   */
  export function onTrigger(opts: {
    on: Trigger;
    body: WorkflowDefinition;
    drainBehavior?: "wait" | "cancel";
    onBodyFailure?: "end" | "tolerate";
    after?: readonly string[];
  }): Primitive;

  // --- Low-level runtime surface (the in-process executor) ---
  // The in-process runtime body and its in-memory env adapters, exported for
  // driving a definition without the supervisor's subprocess/IPC layer.

  export type WorkflowEventBase = { seq: number; at: string };
  export type SignalAwaitedEvent = WorkflowEventBase & {
    kind: "SignalAwaited";
    stepId: string;
    signalName: string;
    timeoutAt?: string;
    parkKind?: string;
  };
  export type WorkflowEvent = SignalAwaitedEvent | (WorkflowEventBase & { kind: string } & Record<string, unknown>);

  export interface RepoStore {
    read(runId: string): Promise<readonly WorkflowEvent[]>;
    [key: string]: unknown;
  }
  export type Scheduler = Record<string, unknown>;
  export interface SignalChannel {
    deliver(name: string, payload: unknown, signalId?: string): Promise<void>;
    awaitNext(name: string, signal?: AbortSignal): Promise<{ payload: unknown; signalId: string }>;
  }
  export type BlobSubstrate = Record<string, unknown>;
  export type DrainController = Record<string, unknown>;
  export type DirectorRegistry = Record<string, unknown>;
  export type WorkflowAuthorizeResult = {
    effect: "allow" | "deny" | "ask";
    matchingGrants: unknown[];
    resolvedBy: unknown;
  };

  export type SpawnChildWorkflow = (input: {
    definitionRef: string;
    childRunId: string;
    input: unknown;
    parentRunId: string;
    parentStepId: string;
    signal: AbortSignal;
    depth: number;
    maxChildSpawnDepth: number;
  }) => Promise<{ terminalStatus: "completed" | "failed" | "cancelled" }>;

  export interface WorkflowRuntimeEnv {
    repoStore: RepoStore;
    scheduler: Scheduler;
    signalChannel: SignalChannel;
    blobs: BlobSubstrate;
    directors: DirectorRegistry;
    authorize: (...args: unknown[]) => Promise<WorkflowAuthorizeResult>;
    invokeStep: (...args: unknown[]) => Promise<{ output: unknown }>;
    spawnChild: SpawnChildWorkflow;
    spawnLoopIteration?: unknown;
    clock: () => Date;
    newId: (prefix: string) => string;
    drain: DrainController;
    [key: string]: unknown;
  }

  export interface RunResult {
    runId: string;
    terminalStatus: "completed" | "failed" | "cancelled";
    outputs: Record<string, unknown>;
    events: readonly WorkflowEvent[];
  }
  export interface WorkflowRun {
    runId: string;
    complete: Promise<RunResult>;
    cancel(origin: "self" | "supervisor-operator", reason: string): Promise<void>;
    signal(name: string, payload: unknown, signalId?: string): Promise<void>;
  }
  export interface RuntimeRunOptions {
    triggerPayload?: unknown;
    runId?: string;
    depth?: number;
    maxChildSpawnDepth?: number;
  }
  export function runtimeRun(
    definition: WorkflowDefinition,
    env: WorkflowRuntimeEnv,
    options?: RuntimeRunOptions,
  ): WorkflowRun;

  export function rewriteInlineChildWorkflowBodies(definition: WorkflowDefinition): {
    workflow: WorkflowDefinition;
    bodies: readonly { ref: string; definition: WorkflowDefinition }[];
  };
  export function enumerateInlineLoopBodies(definition: WorkflowDefinition): readonly {
    ref: string;
    definition: WorkflowDefinition;
  }[];
  export function createSpawnLoopIteration(
    env: WorkflowRuntimeEnv,
    bodies: ReadonlyMap<string, WorkflowDefinition>,
  ): unknown;
  export function createInMemoryRepoStore(): RepoStore;
  export function createInMemoryScheduler(opts: { repoStore: RepoStore; clock: () => Date }): Scheduler;
  export function createInMemorySignalChannel(opts: { newId: (prefix: string) => string }): SignalChannel;
  export function createInMemoryBlobSubstrate(): BlobSubstrate;
  export function createNoopDrainController(definition: WorkflowDefinition): DrainController;

  // --- State-machine read surface (apps/hub/src/lifecycle-run.ts) ---
  // Folding a run's committed events into its current step phases, to read
  // "is this run parked, and on what signal" without a dedicated status API.

  export type StepPhase =
    | "in-flight"
    | "awaiting-signal"
    | "awaiting-timer"
    | "completed"
    | "failed"
    | "routed"
    | "cancelled";
  export interface StepState {
    stepId: string;
    phase: StepPhase;
    currentAttempt: number;
    outputRef?: string;
    lastError?: { message: string };
    awaitingSignal?: { name: string; timeoutAt?: string; parkKind?: string };
    awaitingTimerId?: string;
    [key: string]: unknown;
  }
  export interface ChildState {
    childRunId: string;
    spawnedBy: string;
    cancelRequested: boolean;
    terminalStatus?: "completed" | "failed" | "cancelled";
  }
  export interface RunState {
    runId: string;
    phase: "pending" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
    steps: Map<string, StepState>;
    children: Map<string, ChildState>;
    [key: string]: unknown;
  }
  export function emptyState(runId: string): RunState;
  export function applyEvent(state: RunState, event: WorkflowEvent): RunState;

  /** A loop iteration's body-child run id: `<runId>__<loopStepId>__<index>`. */
  export function loopBodyRunId(runId: string, loopId: string, index: number): string;
}

declare module "@intx/agent" {
  import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";

  export type AgentHandle = Record<string, unknown>;
  /** Director registry used to wire a `WorkflowRuntimeEnv.directors` in the in-process executor. */
  export function createDefaultDirectorRegistry(): Record<string, unknown>;

  /**
   * The env-DI contract `defineTool`'s factories are constructed against.
   * Real `BaseEnv` (`packages/agent/src/env.ts`) requires `sources`,
   * `defaultSource`, `storage`, `workdir`, `audit`, `authorize` and
   * `directors`; loosened to a catch-all here since nothing this repo's own
   * tool packages construct at typecheck time needs those fields checked —
   * only that a caller's richer env structurally satisfies this one.
   */
  export interface BaseEnv {
    [key: string]: unknown;
  }
  export interface ToolDeclaration {
    readonly name: string;
    readonly approval?: "ask";
  }
  export interface ToolBundle {
    readonly definitions: readonly ToolDefinition[];
    run(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
    dispose?(): Promise<void>;
  }
  export type ToolFactory<EnvReq extends BaseEnv = BaseEnv> = (env: EnvReq) => ToolBundle;
  export type AnnotatedToolFactory<EnvReq extends BaseEnv = BaseEnv> = ToolFactory<EnvReq> & {
    readonly id: string;
    readonly requires: readonly string[];
    readonly definitions: readonly ToolDeclaration[];
  };
  export function defineTool<EnvReq extends BaseEnv = BaseEnv>(opts: {
    id: string;
    requires?: readonly string[];
    definitions: readonly ToolDeclaration[];
    factory: ToolFactory<EnvReq>;
  }): AnnotatedToolFactory<EnvReq>;
}

declare module "@intx/inference" {
  import type {
    ConversationTurn,
    ContentBlock,
    InferenceOptions,
    InferenceSource,
    InferenceEvent,
    LastCycleSource,
  } from "@intx/types/runtime";
  import type { CredentialMaterialResolver } from "@intx/types";

  export type {
    ConversationTurn,
    ContentBlock,
    InferenceOptions,
    InferenceEvent,
    LastCycleSource,
  };

  export type BuiltRequest = { url: string; headers: Record<string, string>; body: string };
  export type ProviderAdapter = {
    buildRequest: (
      messages: ConversationTurn[],
      model: string,
      options: InferenceOptions,
    ) => BuiltRequest;
    parseResponse: (payload: string) => InferenceEvent[];
    parseJSONResponse?: (body: string) => InferenceEvent[];
  };
  export type AdapterFactory = (source: LastCycleSource, quirks?: unknown) => ProviderAdapter;
  export type AdapterRegistry = {
    has(provider: string): boolean;
    resolve(source: LastCycleSource, quirks?: unknown): ProviderAdapter;
  };

  export type Scheduler = {
    setTimeout(callback: () => void, delayMs: number): () => void;
    now(): number;
  };
  export type Dependencies = {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    scheduler: Scheduler;
    adapters: AdapterRegistry;
  };

  export type InferenceHarnessOptions = {
    turns: ConversationTurn[];
    source: InferenceSource;
    inferenceOptions?: InferenceOptions;
    signal?: AbortSignal;
    nextSeq: () => number;
    readMaterial?: CredentialMaterialResolver;
    deps: Dependencies;
  };

  export function runInference(opts: InferenceHarnessOptions): AsyncIterable<InferenceEvent>;
  export function createDependencies(adapters: AdapterRegistry): Dependencies;
  export function createDefaultScheduler(): Scheduler;

  export function classifyHTTPError(
    statusCode: number,
    message: string,
    raw?: unknown,
    retryAfterMs?: number,
  ): import("@intx/types/runtime").InferenceError;
  export function createDefaultRetryPolicy(): (situation: {
    error: import("@intx/types/runtime").InferenceError;
    attempt: number;
    elapsedMs: number;
  }) => { kind: "abort" } | { kind: "retry"; delayMs: number };

  export const CREDENTIAL_SENTINEL: string;
  export const BEARER_CREDENTIAL_SENTINEL: string;

  export function parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<string>;
}

declare module "@intx/tool-packaging" {
  export type ToolPackagePin = { name: string; version: string };
  export type ToolPackageManifestEntry = {
    name: string;
    version: string;
    source: { kind: "registry"; registry: string; integrity: string } | {
      kind: "asset";
      assetId: string;
      package: { format: "tarball"; path: string; integrity: string } | { format: "source"; treeOid: string };
    };
  };
  export type ToolPackageManifest = { entries: ToolPackageManifestEntry[] };
  export interface RegistrySource {
    readonly name: string;
    fetchPackument(name: string): Promise<unknown>;
    materializeRefForEntry(name: string, version: string, picked: unknown, integrity: string): unknown;
  }
  export class AssetRegistrySource implements RegistrySource {
    readonly name: string;
    constructor(args: {
      name: string;
      assetId: string;
      readBlob: (path: string) => Promise<Uint8Array>;
      listBlobs: (dir: string) => Promise<string[]>;
    });
    fetchPackument(name: string): Promise<unknown>;
    materializeRefForEntry(name: string, version: string, picked: unknown, integrity: string): unknown;
  }
  export function createClosureResolver(config: {
    registries: ReadonlyMap<string, RegistrySource>;
    defaultRegistry: string;
    scopeRouting?: readonly { scope: string; registry: string }[];
  }): { resolveClosure(pins: readonly ToolPackagePin[]): Promise<ToolPackageManifest> };
  export function parsePin(spec: string): ToolPackagePin;
}

declare module "@intx/types/tool-packages" {
  import type { ToolPackageManifestEntry } from "@intx/tool-packaging";
  export function getToolPackageSourceContentIdentity(source: ToolPackageManifestEntry["source"]): string;
}

declare module "@intx/inference/providers" {
  import type { Dependencies } from "@intx/inference";

  export function createDefaultDependencies(): Dependencies;
  export function createAnthropicAdapter(
    source: import("@intx/inference").LastCycleSource,
    quirks?: unknown,
  ): import("@intx/inference").ProviderAdapter;
  export function createOpenAIAdapter(
    source: import("@intx/inference").LastCycleSource,
    quirks?: unknown,
  ): import("@intx/inference").ProviderAdapter;
}
