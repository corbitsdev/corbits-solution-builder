/**
 * Mounts the Interchange hub inside the Solutions Builder host.
 *
 * The composition itself — pglite binding, `createAuth`/`createApp`, and the
 * process provisioner — lives in `@solutions-builder/embed-hub`. What's left
 * here is this host's own concerns, none of which the package could know:
 *
 *   1. the database is the host's pglite handle (`db.ts`);
 *   2. the at-rest encryption keys and the signing keypair are minted into
 *      the OS keychain on first run (`hub-keys.ts`);
 *   3. the sidecar entry and runtime paths are this checkout's, and the
 *      WebSocket URL they dial is this host's own port.
 *
 * The result is a Hono app. `hub-client.ts` decides whether the rest of the
 * product talks to *this* app in-process or to a hosted one over HTTP — which
 * is what makes "ships inside the desktop app now, hosted later" a
 * configuration change rather than a rewrite.
 */
import { join } from "node:path";
import {
  createEmbeddedHub,
  SIDECAR_WS_PATH,
  type MountedHub,
} from "@solutions-builder/embed-hub";
import { websocket } from "hono/bun";
import { database } from "./db.js";
import { dataDirectory } from "./paths.js";
import { hubEncryptionKeys, hubSigningKey } from "./hub-keys.js";

export type { MountedHub };

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

/** Origin the embedded hub should see, so Better Auth cookies and CSRF match the window. */
export function embeddedHubOrigin(): string {
  return hostPort > 0 ? `http://127.0.0.1:${hostPort}` : "http://hub.local";
}

/** Whether a sidecar could dial back in: false when mounted without serving. */
export function canPlaceSidecars(): boolean {
  return hostPort !== 0;
}

/**
 * What GET /status reports about this process's ability to place a sidecar.
 * `sidecarFingerprint` is null until the hub is mounted — there is no binding
 * to name before then.
 */
export function sidecarFacts(): {
  readonly canPlaceSidecars: boolean;
  readonly sidecarFingerprint: string | null;
} {
  return {
    canPlaceSidecars: canPlaceSidecars(),
    sidecarFingerprint: mounted?.sidecarBindingFingerprint ?? null,
  };
}

/**
 * The path sidecars connect to, served at the hub's own route rather than
 * under the `/hub` proxy: Bun upgrades only the request it handed to `fetch`,
 * so the socket cannot be rewritten on the way in. The host lets this one
 * path through without its session token; the hub checks the sidecar's own.
 */
export { SIDECAR_WS_PATH };

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
  // Persisted, not minted per mount: a deploy commit signed on one run has to
  // still verify on the next.
  const signingKey = await hubSigningKey();
  const hubDataDir = join(dataDirectory(), "hub");

  // Better Auth trusts `BETTER_AUTH_BASE_URL`. Absent, that is localhost:3000,
  // and a first-run sign-up from this host's loopback origin is CSRF-rejected.
  if (hostPort > 0) {
    process.env.BETTER_AUTH_BASE_URL ??= `http://127.0.0.1:${hostPort}`;
  }

  mounted = await createEmbeddedHub({
    pglite: host.raw,
    credentialKeyHex: keys.credentialKeyHex,
    principalKeyHex: keys.principalKeyHex,
    signingKey,
    dataDir: hubDataDir,
    hubWebSocketUrl: `ws://127.0.0.1:${hostPort}${SIDECAR_WS_PATH}`,
    sidecarEntry: SIDECAR_ENTRY,
    sidecarRuntime: SIDECAR_RUNTIME,
  });
  return mounted;
}
