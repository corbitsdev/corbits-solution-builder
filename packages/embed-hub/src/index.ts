/**
 * Composes an Interchange hub from a pglite handle, at-rest keys, and the
 * process provisioner.
 *
 * This is the same wiring Interchange's hub server composes — `createAuth`,
 * the sidecar router, session and workflow services, the event collector
 * registry, and `createApp` — because the vendored tree has no
 * `createHubServer` that accepts an already-open pglite handle and keychain
 * keys. Sidecars are child processes of this host, placed by
 * `@corbits/process-provisioner`. Nothing here is a product API: no command
 * dispatch, projects, proxy, or owner mint.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import {
  createDB,
  createGrantStore,
  createPrincipalKeyStore,
  createPrincipalStore,
  createSidecarAllocationStore,
  createWorkflowRunDispatchStore,
  resolveFrameSenderKey,
  resolveInferenceMaterials,
  resolveSenderKey as resolveSenderKeyStrict,
} from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { hexDecode, hexEncode } from "@intx/types";
import {
  createApp,
  createAuth,
  createMailTriggeredRunGrantsMaterializer,
  createRequireGrant,
  type TenantEnv,
} from "@intx/hub-api";
import { timeWindowEvaluator } from "@intx/authz";
import {
  InlineContentStore,
  mountArtifacts,
  mountWorkflowArtifacts,
  runArtifactMigrations,
  type ArtifactDb,
  type WorkflowArtifactEnv,
} from "@corbits/artifacts";
import {
  createWorkflowArtifactRunResolver,
  ensureWorkflowArtifactTokensTable,
  registerWorkflowArtifactToken,
} from "./workflow-artifact-tokens.js";
import {
  createAgentRepoStore,
  createAssetService,
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarAllocationReconciler,
  createSidecarCredentialResolver,
  createSidecarPluginRegistry,
  createSidecarRouter,
  createWorkflowAllocationService,
  createWorkflowDispatchService,
  WORKSPACE_BUILTINS_REGISTRY,
  type SidecarLookups,
  type WsHandle,
} from "@intx/hub-sessions";
import {
  createProcessSidecarProvisioner,
  readProcessProvisionerConfig,
  type ProcessProvisionerRole,
} from "@corbits/process-provisioner";
import {
  createInMemoryMailboxEventBus,
  createMailboxPersist,
  deliverInboxItems,
  mountMailbox,
  runMailboxMigrations,
  type InboxItem,
} from "@corbits/mailbox";
import { upgradeWebSocket } from "hono/bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as intxSchema from "@intx/db/schema";
import { withPostgresJsResultShape } from "./pg-compat.js";
import { mountProviderOAuth } from "./oauth-mount.js";
import { createSpendApi, createSpendStore, type TurnUsage } from "./spend.js";
import {
  createHubMailboxAuthorizeSender,
  createHubPersistMailWithSessionEnsure,
  type EventCollectorPort,
} from "./mailbox-persist.js";
import { captureMailboxRequest, createMailboxDeliver } from "./mailbox-send.js";

/** The path a sidecar's WebSocket connects to; part of `@intx/hub-api`'s own contract. */
export const SIDECAR_WS_PATH = "/api/sidecars/ws";

/** Shape of `SidecarLookups.persistMail`, narrowed from `unknown` since the
 * lookups map is otherwise untyped. */
type PersistMailFn = (args: {
  senderAddress: string;
  recipients: string[];
  raw: Uint8Array;
}) => Promise<unknown>;

/** The text of a mailbox frame this package built: flat, so everything after the header section is the body. */
function frameBody(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw);
  const split = text.indexOf("\r\n\r\n");
  return split < 0 ? "" : text.slice(split + 4).trimEnd();
}

/**
 * The hub's Ed25519 deploy signing keypair. Must be stable across restarts: a
 * host that persists agent-repo commits signs every one with this key, and a
 * fresh keypair each mount makes all prior signed history unverifiable.
 */
export type HubSigningKey = {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
};

export type CreateEmbeddedHubOptions = {
  /** Already-open pglite client. Bound to Interchange's schema inside this call. */
  readonly pglite: PGlite;
  readonly credentialKeyHex: string;
  readonly principalKeyHex: string;
  readonly signingKey: HubSigningKey;
  /**
   * Where the agent-repo store and the process provisioner keep their state.
   * Created if it does not exist yet.
   */
  readonly dataDir: string;
  /** The WebSocket URL a sidecar dials back into this hub on. */
  readonly hubWebSocketUrl: string;
  /** Interchange sidecar entry the process provisioner spawns. */
  readonly sidecarEntry: string;
  /** Runtime binary the process provisioner execs. */
  readonly sidecarRuntime: string;
};

export type MountedHub = {
  readonly app: Hono;
  /** The hub's own database handle, for callers that need its stores. */
  readonly db: ReturnType<typeof createDB>;
  readonly publicKeyHex: string;
  /**
   * Signs mail on a principal's behalf. Exposed so a host can mint a
   * principal a signing key on first use and sign the mail it composes
   * for a stage thread, the same way the sidecar signs mail for a run.
   */
  readonly principalKeyStore: ReturnType<typeof createPrincipalKeyStore>;
  /**
   * Mints a principal the hub has no invite-based route for yet: the
   * specialist's platform identity, and a run's own actor principal.
   * `createIfAbsent` derives the per-principal wrap a raw insert cannot.
   */
  readonly principalStore: ReturnType<typeof createPrincipalStore>;
  /** Whether a principal row exists by id, a direct read `principalStore`'s natural-key upsert cannot express. */
  principalExists(id: string): Promise<boolean>;
  /** The hub's own auth, so the host can sign the workspace owner in without a browser. */
  readonly auth: ReturnType<typeof createAuth>;
  /**
   * The cipher a `credential` row's `secret` column is sealed under. Kept on
   * the mount for the services composed here that need it (the workflow
   * allocation service, the sidecar credential resolver); a host reaches
   * decrypted material through `resolveCredentialSecret` below, not this
   * field directly.
   */
  readonly credentialCipher: ReturnType<typeof createEnvKeyCredentialCipher>;
  /**
   * The decrypted secret behind a `credential` row, tenant-scoped: a
   * credential id outside the tenant's ancestor chain throws rather than
   * resolving to a null secret. The platform's own `resolveInferenceMaterials`
   * is the single point of decrypt for this material.
   */
  resolveCredentialSecret(tenantId: string, credentialId: string): Promise<string>;
  /** The hub's asset store; a workflow source tree is committed through it. */
  readonly assetService: ReturnType<typeof createAssetService>;
  /**
   * The sidecar router's fence and connection view. The allocation reconciler
   * fences a generation before it spawns; a caller can do the same for a
   * fixture, then watch for the registration.
   */
  readonly sidecars: {
    fence(allocationId: string, generation: number): void;
    connected(): string[];
  };
  /**
   * The sidecar router's event emitter, re-emitting frames such as
   * `agent.event` (an agent step's live inference stream) after the wire
   * layer decodes them.
   */
  readonly events: ReturnType<typeof createSidecarRouter>["events"];
  /**
   * What the deployment provisioner pins a sidecar allocation to: the sidecar
   * entry and the hub address it dials. The platform leaves an allocation
   * bound to any other fingerprint alone forever, so a deployment whose
   * allocation carries a different one is not reachable from this host.
   */
  readonly sidecarBindingFingerprint: string;
  /**
   * Stops the reconcile loop from rescheduling itself. Idempotent, and safe
   * to call mid-cycle: the loop only checks the flag in its own `finally`, so
   * an in-flight tick still finishes. A caller tearing down this mount's
   * database before the process exits needs this — otherwise the loop keeps
   * ticking against a closed handle for as long as the process stays up.
   */
  readonly stopReconcile: () => void;
  /**
   * Delivers one @corbits/mailbox inbox item to every principal directly
   * granted `action` on `resource` (or on `workflow-run:*`) in `tenantId` —
   * the shape a signal grant is minted in (see `grant-namespaces.ts`).
   * `externalId` is the dedup key: calling this again for the same gate
   * (a poll, a retry) delivers nothing new once every holder already has one.
   * Returns the number of principals it delivered to.
   */
  notifyGrantHolders(input: {
    readonly tenantId: string;
    readonly resource: string;
    readonly action: string;
    readonly source: string;
    readonly externalId: string;
    readonly subject: string;
    readonly body: string;
  }): Promise<number>;
};

/**
 * Composes a hub app from the given pglite handle, keys, and sidecar paths.
 * Behaviour matches the previous in-host composition; the host still owns
 * opening the database, minting keys, and serving the socket.
 */
export async function createEmbeddedHub(options: CreateEmbeddedHubOptions): Promise<MountedHub> {
  // The handle must be bound to Interchange's schema, not bare: better-auth's
  // drizzle adapter and every `db.query.*` lookup in the hub resolve tables
  // through that binding, and an unbound handle reports the tables as missing
  // even though they exist.
  //
  // It also needs the postgres.js result shape: Interchange's stores expect
  // `execute` to resolve to a row array, and pglite's resolves to `{ rows }`.
  const bound = drizzle(options.pglite, { schema: intxSchema });
  const db = createDB({
    handle: withPostgresJsResultShape(bound),
    close: async () => undefined,
  });

  const credentialCipher = createEnvKeyCredentialCipher(hexDecode(options.credentialKeyHex));
  const principalKeyStore = createPrincipalKeyStore({
    db: db.db,
    cipher: createEnvKeyCredentialCipher(hexDecode(options.principalKeyHex)),
  });

  await mkdir(options.dataDir, { recursive: true });

  const signingKey = options.signingKey;
  const agentRepoStore = createAgentRepoStore({
    dataDir: options.dataDir,
    signingKey,
    gc: {
      packThreshold: 64,
      looseThreshold: 2048,
      warnBytes: 256 * 1024 * 1024,
      retention: "keep-history",
    },
  });

  const httpRegistries = new Map([["npmjs", { url: "https://registry.npmjs.org" }]]);
  const assetService = createAssetService({
    db: db.db,
    repoStore: agentRepoStore.repoStore,
    reservedPackageRegistryNames: new Set(httpRegistries.keys()),
  });

  // @corbits/mailbox: created here, ahead of `lookups`, so an agent's
  // outbound mail can be wrapped into a durable inbox row below before the
  // sidecar router captures `lookups` by reference.
  const mailboxDb = db.db as unknown as Parameters<typeof mountMailbox>[1]["db"];
  const mailboxBus = createInMemoryMailboxEventBus();

  // `onUsage` fires once per finished inference turn with the provider,
  // model and token counts the sidecar reported -- the one place a round's
  // spend is actually observable (see `spend.ts`). The store it feeds is
  // process memory, not a ledger row: nothing else in this revision of
  // Interchange persists a call's tokens, so a restart starts the count over
  // (the mounted route says so rather than implying continuity).
  //
  // Created ahead of `lookups` (moved up from below `createSidecarRouter`) so
  // the persistMail session-ensure wrapper below can use it.
  const spendStore = createSpendStore();
  const eventCollectors = createEventCollectorRegistry({
    db: db.db,
    onUsage: (_agentAddress: string, usage: TurnUsage) => spendStore.record(usage),
  });

  const lookups: SidecarLookups = {
    ...createHubSessionLookups({ db: db.db, agentRepoStore }),
    materializeMailTriggeredRunGrants: createMailTriggeredRunGrantsMaterializer({
      db: db.db,
      principalKeyStore,
      grantStore: createGrantStore(db.db),
    }),
    // A provisioned deployment's mail dispatch co-delivers the sender's key
    // on the run.grants barrier (`sendWorkflowRunDispatchToAllocation`) so the
    // sidecar's admission policy can verify the signed trigger mail instead of
    // resolving the sender to "unknown" and rejecting it. Without these, every
    // dispatched trigger/signal mail is rejected forever and the run never
    // leaves "pending".
    resolveSenderKey: (address: string) => resolveFrameSenderKey(db.db, principalKeyStore, address),
    resolveSenderKeyStrict: async (address: string) =>
      (await resolveSenderKeyStrict(db.db, principalKeyStore, address))?.publicKey ?? null,
  };
  // Ported from workbench's server.ts: "The sidecar router captured
  // `lookups` before this wrapper existed" — wrap `persistMail` here, before
  // `createSidecarRouter` below closes over `lookups`, so an agent's
  // outbound mail also lands a durable row in every recipient's inbox.
  //
  // The vendored `persistMail` throws `Endpoint … has no session for
  // address …` on a run's first outbound reply, since its `agent_session`
  // doesn't exist until something ensures it. `createHubPersistMailWithSessionEnsure`
  // (ported from workbench's mailbox-persist.ts) sits between it and the
  // mailbox dual-write so that throw is swallowed instead of surfacing as a
  // logged error on every reply.
  const wrappedPersistMail = createMailboxPersist(mailboxDb, {
    upstream: createHubPersistMailWithSessionEnsure(
      db.db,
      eventCollectors as unknown as EventCollectorPort,
      lookups.persistMail as PersistMailFn,
    ),
    authorizeSender: createHubMailboxAuthorizeSender(db.db),
    bus: mailboxBus,
  });
  lookups.persistMail = wrappedPersistMail;

  const sidecarCredentials = createSidecarCredentialResolver({ db: db.db });
  const sidecarRouter = createSidecarRouter({
    hubPublicKey: hexEncode(signingKey.publicKey),
    authenticateSidecar: async ({ token }: { token: string }) =>
      sidecarCredentials.resolve(token),
    validateSidecarIdentity: sidecarCredentials.isCurrent,
    lookups,
  });

  createHubSessionOrchestrator({
    events: sidecarRouter.events,
    router: sidecarRouter,
    db: db.db,
    eventCollectors,
  });

  const sessionService = createSessionService({
    sidecarRouter,
    sidecarAllocationRouter: sidecarRouter,
    agentRepoStore,
    assetService,
    db: db.db,
    toolPackageRegistries: {
      httpRegistries,
      defaultRegistry: "npmjs",
      scopeRouting: [{ scope: "@intx", registry: WORKSPACE_BUILTINS_REGISTRY }],
    },
  });

  const auth = createAuth(db.db);

  // Workflows execute in Interchange's own sidecar, spawned as a child process
  // of this host per allocation. The sidecar seals credentials under a key of
  // its own; it gets the hub's from the environment the provisioner forwards.
  process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"] ??= options.credentialKeyHex;
  const provisionerFor = (role: ProcessProvisionerRole) =>
    createProcessSidecarProvisioner({
      role,
      config: readProcessProvisionerConfig({
        env: {
          PROCESS_PROVISIONER_SIDECAR_ENTRY: options.sidecarEntry,
          PROCESS_PROVISIONER_RUNTIME: options.sidecarRuntime,
        },
        dataDir: join(options.dataDir, role === "probe" ? "process-provisioner-probe" : "process-provisioner"),
        hubWebSocketUrl: options.hubWebSocketUrl,
      }),
    });
  const deploymentProvisioner = provisionerFor("deployment");
  // The typecheck stub of the provisioner package does not type the field.
  const bindingFingerprint = String((deploymentProvisioner as { bindingFingerprint?: unknown }).bindingFingerprint ?? "");
  const sidecarPlugins = createSidecarPluginRegistry({ provisioners: [deploymentProvisioner] });
  const probeSidecarPlugins = createSidecarPluginRegistry({ provisioners: [provisionerFor("probe")] });

  const workflowAllocationService = createWorkflowAllocationService({
    db: db.db,
    deploymentPlugins: sidecarPlugins,
    probePlugins: probeSidecarPlugins,
    preparedDeployer: sessionService,
    credentialCipher,
    allocationRouter: sidecarRouter,
    hubWebSocketUrl: options.hubWebSocketUrl,
  });
  const sidecarAllocationStore = createSidecarAllocationStore(db.db);
  const workflowDispatchService = createWorkflowDispatchService({
    dispatchStore: createWorkflowRunDispatchStore(db.db),
    allocationStore: sidecarAllocationStore,
    router: sidecarRouter,
    resolveAnchorAddress: async (anchorRunId: string) => {
      const rows = (await bound.execute(
        sql`SELECT "address" FROM "public"."workflow_run" WHERE "id" = ${anchorRunId} LIMIT 1`,
      )) as unknown as { rows?: { address: string | null }[] } | { address: string | null }[];
      const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
      return row?.address ?? null;
    },
  });
  const sidecarAllocationReconciler = createSidecarAllocationReconciler({
    allocationStore: sidecarAllocationStore,
    plugins: sidecarPlugins,
    router: sidecarRouter,
    hubWebSocketUrl: options.hubWebSocketUrl,
    // Process-provisioned sidecars die with the host. Replacing them lets
    // `restoreWorkflowRunToAllocation` replay each run's hub-held refs onto the
    // new generation; releasing them fails the run and a project restarts at
    // stage 1 (CL-8784).
    enableAutomaticReplacementRecovery: true,
    onReady: async (allocation: { anchorRunId: string }, reconciliation: { signal: AbortSignal }) => {
      await workflowAllocationService.deployReadyAllocation(allocation, reconciliation);
      await workflowDispatchService.requeueForReadyAllocation(allocation.anchorRunId);
    },
  });
  await workflowAllocationService.initialize?.();
  await sidecarAllocationReconciler.initialize();
  type Allocated = Record<string, unknown> | undefined;
  sidecarRouter.events.on("sidecar.disconnect", ({ allocated }: { allocated: Allocated }) => {
    if (allocated === undefined) return;
    return sidecarAllocationReconciler.handleDisconnect(allocated);
  });
  sidecarRouter.events.on("sidecar.allocated.connected", (allocated: Allocated) =>
    sidecarAllocationReconciler.handleConnected(allocated),
  );
  sidecarRouter.events.on(
    "mail.inbound.acknowledged",
    ({ messageId, allocated }: { messageId: string; allocated: Allocated }) => {
      if (allocated === undefined) return;
      return workflowDispatchService.acknowledge({ ...allocated, messageId });
    },
  );
  const socketRouter = sidecarRouter as unknown as {
    handleOpen(ws: WsHandle): void;
    handleMessage(ws: WsHandle, data: string): void;
    handleClose(ws: WsHandle): void;
    fenceAllocation(allocationId: string, generation: number): void;
    getConnectedSidecars(): string[];
  };

  // The same cadence Interchange's own hub uses. Timers are unref'd so a host
  // that is stopping does not wait on them.
  const RECONCILE_MS = 1_000;
  const REPAIR_MS = 30_000;
  let nextRepairAt = Date.now() + REPAIR_MS;
  let nextProbeCleanupAt = Date.now() + REPAIR_MS;
  // Set by `stopReconcile()`. A tick already in flight when it is set still
  // runs to completion against whatever the caller is tearing down — if that
  // is the database, the tick fails, but a stopping mount asked for exactly
  // that, so it is not logged as a failure. It just does not reschedule.
  let reconcileStopped = false;
  const reconcile = async () => {
    try {
      if (Date.now() >= nextProbeCleanupAt) {
        nextProbeCleanupAt = Date.now() + REPAIR_MS;
        await workflowAllocationService.reconcileReleasingProbes?.();
      }
      await sidecarAllocationReconciler.reconcileUntilIdle();
      await workflowDispatchService.reconcileUntilIdle();
      if (Date.now() >= nextRepairAt) {
        nextRepairAt = Date.now() + REPAIR_MS;
        await sidecarAllocationReconciler.repairUnscheduledConnections();
      }
    } catch (cause) {
      if (!reconcileStopped) {
        console.error(`Sidecar reconciliation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    } finally {
      if (!reconcileStopped) setTimeout(() => void reconcile(), RECONCILE_MS).unref();
    }
  };
  setTimeout(() => void reconcile(), 0).unref();

  // @corbits/mailbox: an open decision's inbox item, and the desktop's
  // notifications bell. Reached over `/api/me/inbox*`; the mounted routes
  // resolve their own caller session, so nothing about the ledger's
  // decisions lives on this mount besides the resolver and address below.
  // `mailboxDb`/`mailboxBus` are the same handle and bus `lookups.persistMail`
  // was wrapped onto above. The mount's own `MailboxDb` type names
  // `postgres-js`'s driver, but reads nothing but plain drizzle
  // query-builder calls; this pglite handle (already wearing the
  // postgres.js result shape every other store here expects) satisfies it
  // at runtime the same way it does theirs.
  async function principalAddress(principal: { tenantId: string; principalId: string }): Promise<string> {
    const [tenantRow] = (await db.db.execute(
      sql`SELECT "domain" FROM "public"."tenant" WHERE "id" = ${principal.tenantId} LIMIT 1`,
    )) as unknown as { domain: string }[];
    if (tenantRow === undefined) {
      throw new Error(`no tenant "${principal.tenantId}" to address a mailbox sender from`);
    }
    const [principalRow] = (await db.db.execute(
      sql`SELECT "ref_id" AS "refId" FROM "public"."principal" WHERE "id" = ${principal.principalId} LIMIT 1`,
    )) as unknown as { refId: string }[];
    if (principalRow === undefined) {
      throw new Error(`no principal "${principal.principalId}" to address a mailbox sender as`);
    }
    return `${principalRow.refId}@${tenantRow.domain}`;
  }
  await runMailboxMigrations(mailboxDb);
  const mailboxApp = new Hono();
  mountMailbox(mailboxApp, {
    db: mailboxDb,
    bus: mailboxBus,
    resolvePrincipal: async (ctx: unknown) => {
      const request = (ctx as { req: { raw: Request } }).req.raw;
      const result = (await auth.api.getSession({ headers: request.headers })) as { user?: { id: string } } | null;
      if (!result?.user) return null;
      const [row] = (await db.db.execute(
        sql`SELECT "id", "tenant_id" AS "tenantId" FROM "public"."principal" WHERE "kind" = 'user' AND "ref_id" = ${result.user.id} AND "status" = 'active' LIMIT 1`,
      )) as unknown as { id: string; tenantId: string }[];
      return row ? { tenantId: row.tenantId, principalId: row.id } : null;
    },
    senderAddressFor: principalAddress,
    // Single-workspace host: a person's own sent mail is addressed to
    // another principal in the same workspace, so "delivery" is just
    // filing it into that principal's own inbox.
    deliver: async (message) => {
      for (const to of message.to) {
        const [refId, domain] = to.split("@");
        if (!refId || !domain) continue;
        const [tenantRow] = (await db.db.execute(
          sql`SELECT "id" FROM "public"."tenant" WHERE "domain" = ${domain} LIMIT 1`,
        )) as unknown as { id: string }[];
        if (!tenantRow) continue;
        const [recipient] = (await db.db.execute(
          sql`SELECT "id" FROM "public"."principal" WHERE "tenant_id" = ${tenantRow.id} AND "kind" = 'user' AND "ref_id" = ${refId} LIMIT 1`,
        )) as unknown as { id: string }[];
        if (!recipient) continue;
        await deliverInboxItems(
          mailboxDb,
          [
            {
              tenantId: tenantRow.id,
              principalId: recipient.id,
              address: to,
              fromAddress: message.from,
              subject: "",
              body: frameBody(message.raw),
              source: "mailbox-send",
              externalId: message.messageId,
            },
          ],
          { bus: mailboxBus },
        );
      }
    },
  });

  async function notifyGrantHolders(input: {
    readonly tenantId: string;
    readonly resource: string;
    readonly action: string;
    readonly source: string;
    readonly externalId: string;
    readonly subject: string;
    readonly body: string;
  }): Promise<number> {
    const holders = (await db.db.execute(
      sql`SELECT DISTINCT "principal_id" AS "principalId" FROM "public"."grant"
          WHERE "tenant_id" = ${input.tenantId}
            AND "action" = ${input.action}
            AND "effect" = 'allow'
            AND "role_id" IS NULL
            AND "principal_id" IS NOT NULL
            AND ("resource" = ${input.resource} OR "resource" = 'workflow-run:*')`,
    )) as unknown as { principalId: string | null }[];
    const principalIds = [...new Set(holders.map((row) => row.principalId).filter((id): id is string => id !== null))];
    if (principalIds.length === 0) return 0;
    const items: InboxItem[] = [];
    for (const principalId of principalIds) {
      const address = await principalAddress({ tenantId: input.tenantId, principalId });
      items.push({
        tenantId: input.tenantId,
        principalId,
        address,
        fromAddress: `solutions-builder@${input.tenantId}.local`,
        subject: input.subject,
        body: input.body,
        source: input.source,
        externalId: input.externalId,
      });
    }
    const delivered = await deliverInboxItems(mailboxDb, items, { bus: mailboxBus });
    return delivered.length;
  }

  const app = createApp({
    getSession: async (headers: Headers) => {
      const result = (await auth.api.getSession({ headers })) as {
        user?: unknown;
        session?: unknown;
      } | null;
      return result ? { user: result.user, session: result.session } : null;
    },
    authHandler: (context: { req: { raw: Request } }) => auth.handler(context.req.raw),
    db: db.db,
    sidecarRouter,
    sessionService,
    eventCollectors,
    credentialCipher,
    principalKeyStore,
    assetService,
    repoStore: agentRepoStore.repoStore,
    maxTarballBytes: 10 * 1024 * 1024,
    workflowAllocationService,
    workflowDispatchService,
    sidecarWsHandler: upgradeWebSocket(() => {
      let handle: WsHandle;
      return {
        onOpen(_event, ws) {
          handle = {
            send(data: string) {
              ws.send(data);
            },
            close() {
              ws.close();
            },
          };
          socketRouter.handleOpen(handle);
        },
        onMessage(event) {
          socketRouter.handleMessage(handle, String(event.data));
        },
        onClose() {
          socketRouter.handleClose(handle);
        },
      };
    }),
  });
  app.route("/api", mailboxApp);

  // Provider sign-in (ChatGPT/Codex, xAI/Grok): PKCE + loopback OAuth login
  // through `@corbits/oauth-core`, not something vendor Interchange's own
  // routes provide. Persisting the exchanged tokens as a credential is the
  // client's job (`packages/installer/src/provider-connect.ts`), same as an
  // API key.
  mountProviderOAuth(app);
  // `@corbits/artifacts` is a mountable Interchange module, not host code:
  // it owns its own schema/migrations and reads tenant/principal off the
  // context the hub's own `/api/tenants/:tenantId/*` middleware places
  // there. Migrating and mounting here — the hub's own composition step —
  // is what makes its routes reachable from outside apps/hub/src.
  const artifactDb = withPostgresJsResultShape(db.db) as unknown as ArtifactDb;
  await runArtifactMigrations(artifactDb);
  const artifactsApi = new Hono<TenantEnv>();
  mountArtifacts(artifactsApi, {
    db: artifactDb,
    contentStore: InlineContentStore,
    requireGrant: createRequireGrant({
      grantStore: createGrantStore(db.db),
      conditionRegistry: { time_window: timeWindowEvaluator },
    }),
    // The package mints no grants itself (see its README). Without this, a
    // caller who just created an artifact could never revise or archive it —
    // `POST /artifacts/:id/versions` and `/archive` both require a `write`/
    // `archive` grant on `artifact:<id>` that nothing else would ever mint.
    onArtifactCreated: async (tx, row, scope) => {
      const now = new Date();
      for (const action of ["write", "archive"] as const) {
        await tx.execute(sql`
          INSERT INTO "grant"
            ("id", "tenant_id", "role_id", "principal_id", "resource", "action", "effect", "conditions", "origin", "expires_at", "created_at", "updated_at")
          VALUES
            (${`grant_${row.id}_${action}`}, ${scope.tenantId}, NULL, ${scope.principalId}, ${`artifact:${row.id}`}, ${action}, 'allow', NULL, 'creator', NULL, ${now}, ${now})
          ON CONFLICT DO NOTHING
        `);
      }
    },
  });
  app.route("/api/tenants/:tenantId", artifactsApi);

  // Run-scoped mount: how a deployed specialist's `@corbits/artifacts`
  // sidecar-bundle (the `hub` credential handle) writes/reads artifacts on
  // its own run's behalf, with no browser session and no `tenantId` path
  // param -- see `workflow-artifact-tokens.ts` for why this is a
  // purpose-minted bearer rather than the sidecar's own ambient token.
  await ensureWorkflowArtifactTokensTable(db.db);
  const workflowArtifactsApi = new Hono<WorkflowArtifactEnv>();
  mountWorkflowArtifacts(workflowArtifactsApi, {
    db: artifactDb,
    contentStore: InlineContentStore,
    resolveRunScope: createWorkflowArtifactRunResolver(db.db),
  });
  app.route("/api/workflow-artifacts", workflowArtifactsApi);

  // The installer's registration call for the bearer it just minted and
  // stored as a tenant credential (`specialist-deploy.ts`): this is the one
  // write into `workflow_artifact_token`, made under the normal tenant
  // session the installer already authenticates with, never by the run
  // itself.
  const workflowArtifactTokensApi = new Hono<TenantEnv>();
  workflowArtifactTokensApi.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { token, anchorRunId } = body as { token?: unknown; anchorRunId?: unknown };
    if (typeof token !== "string" || token === "" || typeof anchorRunId !== "string" || anchorRunId === "") {
      return c.json({ error: "token and anchorRunId are required" }, 400);
    }
    const tenantId = (c.get("tenant") as { id: string }).id;
    await registerWorkflowArtifactToken(db.db, { token, tenantId, anchorRunId });
    return c.json({ data: { ok: true } }, 201);
  });
  app.route("/api/tenants/:tenantId/workflow-artifact-tokens", workflowArtifactTokensApi);

  // Read-only workspace inference spend, folded from `onUsage` above --
  // see `spend.ts` for what it can and cannot answer.
  app.route("/api/tenants/:tenantId/spend", createSpendApi(db.db, spendStore));

  // A second @corbits/mailbox mount, tenant-scoped, alongside the
  // single-workspace `/api/me/inbox*` one above: mail addressed to a run
  // address (`<runId>@<tenant.domain>`) must reach that run's trigger route,
  // which needs the `tenantId` path param the single-workspace mount has no
  // reason to carry. Ported from workbench's server.ts 586-620.
  const runMailboxApp = new Hono<TenantEnv>();
  // Registered before the route: Hono runs handlers in registration order.
  runMailboxApp.use("/me/inbox/send", captureMailboxRequest());
  mountMailbox(runMailboxApp, {
    db: mailboxDb,
    bus: mailboxBus,
    resolvePrincipal: (ctx) => {
      const c = ctx as { get(key: "tenant" | "principal"): { id: string } };
      return { tenantId: c.get("tenant").id, principalId: c.get("principal").id };
    },
    senderAddressFor: principalAddress,
    deliver: createMailboxDeliver({ app, persistMail: wrappedPersistMail }),
  });
  app.route("/api/tenants/:tenantId/mailbox", runMailboxApp);

  return {
    app,
    db,
    notifyGrantHolders,
    publicKeyHex: hexEncode(signingKey.publicKey),
    principalKeyStore,
    principalStore: createPrincipalStore(db.db, principalKeyStore),
    principalExists: async (id: string) =>
      (
        (await db.db.execute(
          sql`SELECT "id" FROM "public"."principal" WHERE "id" = ${id} LIMIT 1`,
        )) as unknown as { id: string }[]
      ).length > 0,
    auth,
    credentialCipher,
    resolveCredentialSecret: async (scopeTenantId: string, credentialId: string) => {
      const [material] = await resolveInferenceMaterials(
        db.db,
        scopeTenantId,
        [credentialId],
        credentialCipher,
      );
      if (!material) {
        throw new Error(`credential ${credentialId} could not be resolved for tenant ${scopeTenantId}`);
      }
      return material.secret;
    },
    assetService,
    sidecars: {
      fence: (allocationId, generation) => socketRouter.fenceAllocation(allocationId, generation),
      connected: () => socketRouter.getConnectedSidecars(),
    },
    events: sidecarRouter.events,
    sidecarBindingFingerprint: bindingFingerprint,
    stopReconcile: () => {
      reconcileStopped = true;
    },
  };
}
