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
}

declare module "@intx/crypto" {
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
  export function createAssetService(opts: Record<string, unknown>): unknown;
  export function createEventCollectorRegistry(opts: Record<string, unknown>): unknown;
  export function createHubSessionLookups(opts: Record<string, unknown>): Record<string, unknown>;
  export function createHubSessionOrchestrator(opts: Record<string, unknown>): unknown;
  export function createSessionService(opts: Record<string, unknown>): unknown;
  export function createSidecarAllocationReconciler(opts: Record<string, unknown>): {
    initialize: () => Promise<void>;
    reconcileUntilIdle: () => Promise<void>;
    repairUnscheduledConnections: () => Promise<void>;
    handleDisconnect: (allocated: unknown) => unknown;
    handleConnected: (allocated: unknown) => unknown;
  };
  export function createSidecarPluginRegistry(opts: Record<string, unknown>): unknown;
  export function createSidecarRouter(opts: Record<string, unknown>): Record<string, unknown> & {
    events: { on: (name: string, handler: (payload: never) => unknown) => void };
  };
  export function createSidecarCredentialResolver(opts: Record<string, unknown>): {
    resolve: (token: string) => Promise<unknown>;
    isCurrent: (...args: unknown[]) => unknown;
  };
  export function createWorkflowAllocationService(opts: Record<string, unknown>): {
    initialize?: () => Promise<void>;
    reconcileReleasingProbes?: () => Promise<void>;
    deployReadyAllocation: (allocation: unknown) => Promise<void>;
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

  // --- Low-level runtime surface (scripts/executor-spike.ts) ---
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

  // --- State-machine read surface (apps/hub/src/hub-executor.ts) ---
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
  export interface RunState {
    runId: string;
    steps: Map<string, StepState>;
    [key: string]: unknown;
  }
  export function emptyState(runId: string): RunState;
  export function applyEvent(state: RunState, event: WorkflowEvent): RunState;
}

declare module "@intx/agent" {
  export type AgentHandle = Record<string, unknown>;
  /** Director registry used to wire a `WorkflowRuntimeEnv.directors` in scripts/executor-spike.ts. */
  export function createDefaultDirectorRegistry(): Record<string, unknown>;
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
