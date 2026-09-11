/**
 * Mounts the Interchange hub inside the Solutions Builder host.
 *
 * This composes the same services Interchange's hub server composes —
 * `createAuth`, the sidecar router, session and workflow services, the event
 * collector registry, and `createApp` — because the vendored tree has no
 * `createHubServer` that accepts this process's pglite handle and keychain
 * keys. Two differences, both required by a desktop app and neither of which
 * forks behaviour:
 *
 *   1. the database is the host's pglite handle, injected through the vendored
 *      `createDB` patch, so no Postgres server has to be running;
 *   2. the at-rest encryption keys are minted into the OS keychain on first run
 *      instead of being demanded from the environment, which still wins when
 *      set.
 *
 * The result is a Hono app. `hub-client.ts` decides whether the rest of the
 * product talks to *this* app in-process or to a hosted one over HTTP — which
 * is what makes "ships inside the desktop app now, hosted later" a
 * configuration change rather than a rewrite.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Hono } from "hono";
import {
  createDB,
  createGrantStore,
  createPrincipalKeyStore,
  createSidecarAllocationStore,
  createWorkflowRunDispatchStore,
} from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { hexDecode, hexEncode } from "@intx/types";
import {
  createApp,
  createAuth,
  createMailTriggeredRunGrantsMaterializer,
} from "@intx/hub-api";
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
import { upgradeWebSocket, websocket } from "hono/bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as intxSchema from "@intx/db/schema";
import { database } from "./db.js";
import { dataDirectory } from "./paths.js";
import { hubEncryptionKeys, hubSigningKey } from "./hub-keys.js";
import { withPostgresJsResultShape } from "./pg-compat.js";

export type MountedHub = {
  readonly app: Hono;
  /** The hub's own database handle, for callers that need its stores. */
  readonly db: ReturnType<typeof createDB>;
  readonly publicKeyHex: string;
  /**
   * The hub's git-backed repo store. A definition's body — the system prompt
   * an agent actually reads — is a commit on its deploy ref here, which is
   * where the platform expects it to live and where a sidecar pulls it from.
   */
  readonly agentRepoStore: ReturnType<typeof createAgentRepoStore>;
  /**
   * Signs mail on a principal's behalf. Exposed so `hub/conversation.ts` can
   * mint a principal a signing key on first use and sign the mail it composes
   * for a stage thread, the same way the sidecar signs mail for a run.
   */
  readonly principalKeyStore: ReturnType<typeof createPrincipalKeyStore>;
  /** The hub's own auth, so the host can sign the workspace owner in without a browser. */
  readonly auth: ReturnType<typeof createAuth>;
  /** The hub's asset store; a workflow source tree is committed through it. */
  readonly assetService: ReturnType<typeof createAssetService>;
  /**
   * The sidecar router's fence and connection view. The allocation reconciler
   * fences a generation before it spawns; the sidecar smoke does the same for
   * its fixture, then watches for the registration.
   */
  readonly sidecars: {
    fence(allocationId: string, generation: number): void;
    connected(): string[];
  };
  /**
   * The sidecar router's event emitter, re-emitting frames such as
   * `agent.event` (an agent step's live inference stream) after the wire
   * layer decodes them. Exposed so the host can feed the live-draft pane
   * from a run's own signals instead of an in-process callback.
   */
  readonly events: ReturnType<typeof createSidecarRouter>["events"];
};

let mounted: MountedHub | null = null;

/**
 * The port the host serves on. Sidecars dial back into the hub over a
 * WebSocket on this port, and the provisioner's binding fingerprint includes
 * the URL, so the server sets it before the first mount. Smokes that mount
 * without serving leave it at 0; no allocation can happen there anyway.
 */
let hostPort = 0;
export function setHostPort(port: number): void {
  hostPort = port;
}

/** Whether a sidecar could dial back in: false when mounted without serving. */
export function canPlaceSidecars(): boolean {
  return hostPort !== 0;
}

/**
 * The path sidecars connect to, served at the hub's own route rather than
 * under the `/hub` proxy: Bun upgrades only the request it handed to `fetch`,
 * so the socket cannot be rewritten on the way in. The host lets this one
 * path through without its session token; the hub checks the sidecar's own.
 */
export const SIDECAR_WS_PATH = "/api/sidecars/ws";

/** Bun's WebSocket handler for the sidecar socket; `Bun.serve` needs it beside `fetch`. */
export { websocket as hubWebSocket };

const SIDECAR_ENTRY = join(
  import.meta.dir, "..", "..", "..", "vendor", "interchange", "apps", "sidecar", "src", "index.ts",
);
const SIDECAR_RUNTIME = join(import.meta.dir, "..", "bin", "sidecar-runtime");

export function hub(): MountedHub {
  if (!mounted) throw new Error("The Interchange hub is not mounted.");
  return mounted;
}

export function hubIsMounted(): boolean {
  return mounted !== null;
}

export async function mountHub(): Promise<MountedHub> {
  if (mounted) return mounted;

  const host = database();
  const keys = await hubEncryptionKeys();

  // The handle must be bound to Interchange's schema, not bare: better-auth's
  // drizzle adapter and every `db.query.*` lookup in the hub resolve tables
  // through that binding, and an unbound handle reports the tables as missing
  // even though they exist.
  //
  // It also needs the postgres.js result shape: Interchange's stores expect
  // `execute` to resolve to a row array, and pglite's resolves to `{ rows }`.
  const bound = drizzle(host.raw, { schema: intxSchema });
  const db = createDB({
    handle: withPostgresJsResultShape(bound),
    close: async () => undefined,
  });

  const credentialCipher = createEnvKeyCredentialCipher(hexDecode(keys.credentialKeyHex));
  const principalKeyStore = createPrincipalKeyStore({
    db: db.db,
    cipher: createEnvKeyCredentialCipher(hexDecode(keys.principalKeyHex)),
  });

  const hubDataDir = join(dataDirectory(), "hub");
  await mkdir(hubDataDir, { recursive: true });

  // Persisted, not minted per mount: a deploy commit signed on one run has to
  // still verify on the next.
  const signingKey = await hubSigningKey();
  const agentRepoStore = createAgentRepoStore({
    dataDir: hubDataDir,
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
  process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"] ??= keys.credentialKeyHex;
  const hubWebSocketUrl = `ws://127.0.0.1:${hostPort}${SIDECAR_WS_PATH}`;
  const provisionerFor = (role: ProcessProvisionerRole) =>
    createProcessSidecarProvisioner({
      role,
      config: readProcessProvisionerConfig({
        env: {
          PROCESS_PROVISIONER_SIDECAR_ENTRY: SIDECAR_ENTRY,
          PROCESS_PROVISIONER_RUNTIME: SIDECAR_RUNTIME,
        },
        dataDir: join(hubDataDir, role === "probe" ? "process-provisioner-probe" : "process-provisioner"),
        hubWebSocketUrl,
      }),
    });
  const sidecarPlugins = createSidecarPluginRegistry({ provisioners: [provisionerFor("deployment")] });
  const probeSidecarPlugins = createSidecarPluginRegistry({ provisioners: [provisionerFor("probe")] });

  const workflowAllocationService = createWorkflowAllocationService({
    db: db.db,
    deploymentPlugins: sidecarPlugins,
    probePlugins: probeSidecarPlugins,
    preparedDeployer: sessionService,
    credentialCipher,
    allocationRouter: sidecarRouter,
    hubWebSocketUrl,
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
    hubWebSocketUrl,
    onReady: async (allocation: { anchorRunId: string }) => {
      await workflowAllocationService.deployReadyAllocation(allocation);
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
      console.error(`Sidecar reconciliation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setTimeout(() => void reconcile(), RECONCILE_MS).unref();
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

  mounted = {
    app,
    db,
    publicKeyHex: hexEncode(signingKey.publicKey),
    agentRepoStore,
    principalKeyStore,
    auth,
    assetService,
    sidecars: {
      fence: (allocationId, generation) => socketRouter.fenceAllocation(allocationId, generation),
      connected: () => socketRouter.getConnectedSidecars(),
    },
    events: sidecarRouter.events,
  };
  return mounted;
}
