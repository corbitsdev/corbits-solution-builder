/**
 * `@corbits/embedded-host` — the host process a desktop product
 * composes: data paths, pglite, keychain secrets, vendored hub migrations,
 * the embedded Interchange hub mount, the loopback server skeleton, session
 * handshake, sidecar reaping and lifecycle.
 *
 * Nothing here names a product: `initHost` declares the identity first, and
 * `serveHost` takes the product's `/api` routes and interface directories.
 */
export { initHost, hostIdentity, type HostIdentity } from "./identity.js";
export { serveHost, type ServeOptions } from "./serve.js";

export { dataDirectory, databaseDirectory, portFile } from "./paths.js";
export { openDatabase, database, type HostDatabase, type Db } from "./db.js";
export { migrateHub, PreHubDatabaseError } from "./hub-migrate.js";
export { HUB_MIGRATIONS } from "./hub-migrations.js";
export { hubEncryptionKeys, hubSigningKey } from "./hub-keys.js";
export {
  credentialBackend,
  readSecretResult,
  secretReference,
  storeSecret,
  type CredentialBackend,
  type SecretRead,
} from "./host-secrets.js";
export { stopSpawnedSidecars } from "./sidecar-processes.js";
export {
  hub,
  hubIsMounted,
  mountHub,
  embeddedHubOrigin,
  canPlaceSidecars,
  sidecarFacts,
  setHostPort,
  hubWebSocket,
  SIDECAR_WS_PATH,
  type MountedHub,
} from "./hub-mount.js";
export {
  ensureHub,
  hubFetch,
  hubMode,
  remoteHubOrigin,
  currentSession,
  signInEmail,
  signUpEmail,
  mintOwnerSetCookie,
  hubTransport,
  resolveWorkspace,
  forgetWorkspace,
  assets,
  type HubEndpoint,
  type HubMode,
  type HubAsset,
} from "./hub-client.js";
export {
  hostStatus,
  startHeartbeat,
  markReady,
  markStopped,
  clientConnected,
  type HostState,
} from "./lifecycle.js";
export { HostError, ERROR_CODES, type ErrorCode } from "./errors.js";
