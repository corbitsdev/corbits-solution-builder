/**
 * Mounts the Interchange hub inside the Solutions Builder host.
 *
 * This composes the same services `apps/hub/src/server.ts` composes upstream —
 * `createAuth`, the sidecar router, session and workflow services, the event
 * collector registry, and `createApp` — with two differences, both required by
 * a desktop app and neither of which forks behaviour:
 *
 *   1. the database is the host's pglite handle, injected through the vendored
 *      `createDB` patch, so no Postgres server has to be running;
 *   2. the at-rest encryption keys are minted into the OS keychain on first run
 *      instead of being demanded from the environment, which still wins when
 *      set.
 *
 * The result is a Hono app. `hub/endpoint.ts` decides whether the rest of the
 * product talks to *this* app in-process or to a hosted one over HTTP — which
 * is what makes "ships inside the desktop app now, hosted later" a
 * configuration change rather than a rewrite.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Hono } from "hono";
import { createDB, createGrantStore, createPrincipalKeyStore } from "@intx/db";
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
  createSidecarCredentialResolver,
  createSidecarRouter,
  WORKSPACE_BUILTINS_REGISTRY,
  type SidecarLookups,
} from "@intx/hub-sessions";
import { drizzle } from "drizzle-orm/pglite";
import * as intxSchema from "@intx/db/schema";
import { database } from "../db/client.js";
import { dataDirectory } from "../paths.js";
import { hubEncryptionKeys, hubSigningKey } from "./keys.js";
import { withPostgresJsResultShape } from "../db/pg-compat.js";

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
};

let mounted: MountedHub | null = null;

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

  // No sidecar provisioners are registered: this host runs no remote workers
  // yet, and an empty registry is the honest state rather than a stub that
  // would advertise placement it cannot perform.
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
  });

  mounted = {
    app,
    db,
    publicKeyHex: hexEncode(signingKey.publicKey),
    agentRepoStore,
    principalKeyStore,
  };
  return mounted;
}
