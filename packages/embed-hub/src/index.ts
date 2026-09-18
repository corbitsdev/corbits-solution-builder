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
  resolveInferenceMaterials,
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
  runArtifactMigrations,
  type ArtifactDb,
} from "@corbits/artifacts";
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
import { upgradeWebSocket } from "hono/bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as intxSchema from "@intx/db/schema";
import { withPostgresJsResultShape } from "./pg-compat.js";
import { retireDeadSidecars } from "./retire-dead-sidecars.js";
import { mountProviderOAuth } from "./oauth-mount.js";

/** The path a sidecar's WebSocket connects to; part of `@intx/hub-api`'s own contract. */
export const SIDECAR_WS_PATH = "/api/sidecars/ws";

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

  const lookups: SidecarLookups = {
    ...createHubSessionLookups({ db: db.db, agentRepoStore }),
    materializeMailTriggeredRunGrants: createMailTriggeredRunGrantsMaterializer({
      db: db.db,
      principalKeyStore,
      grantStore: createGrantStore(db.db),
    }),
  };

  const sidecarCredentials = createSidecarCredentialResolver({ db: db.db });
  const sidecarRouter = createSidecarRouter({
    hubPublicKey: hexEncode(signingKey.publicKey),
    authenticateSidecar: async ({ token }: { token: string }) =>
      sidecarCredentials.resolve(token),
    validateSidecarIdentity: sidecarCredentials.isCurrent,
    lookups,
  });

  // The registry's `onUsage` sink is not wired: in this Interchange revision
  // nothing creates a collector, so `dispatch` drops every frame and the sink
  // never fires. A round's spend is read from the `agent.event` stream itself;
  // a sink here as well would count a call twice once a revision does create
  // collectors.
  const eventCollectors = createEventCollectorRegistry({ db: db.db });

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
    onReady: async (allocation: { anchorRunId: string }) => {
      await workflowAllocationService.deployReadyAllocation(allocation);
      await workflowDispatchService.requeueForReadyAllocation(allocation.anchorRunId);
    },
  });
  await workflowAllocationService.initialize?.();
  await sidecarAllocationReconciler.initialize();
  await retireDeadSidecars(sidecarAllocationStore, bindingFingerprint);
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

  return {
    app,
    db,
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
