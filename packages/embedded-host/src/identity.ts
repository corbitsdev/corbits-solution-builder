/**
 * Which product this host is. Everything in the package is the generic
 * machinery a desktop shell embedding an Interchange hub needs; the strings
 * and names that make it *this* product are declared once, here, by the
 * entrypoint before `serveHost` runs.
 */
import type { CallbackPageCopy } from "@corbits/embed-hub";
import { configureKeychain } from "@corbits/keychain";
import { dataDirectory } from "./paths.js";

export interface HostIdentity {
  /** Directory name under the OS application-data root (`~/Library/Application Support/<appDir>`). */
  appDir: string;
  /** Human-facing product name, used in logs and error messages. */
  displayName: string;
  /** Environment prefix: `<envPrefix>_DATA_DIR`, `_HUB_URL`, `_DIST_DIR`, `_DEV_RELOAD`. */
  envPrefix: string;
  /** The `security -s` service name the keychain store keeps secrets under. Stable: renaming orphans minted keys. */
  keychainService: string;
  /** Copy for the OAuth callback page the hub's loopback provider login serves. */
  oauthPageCopy: CallbackPageCopy;
  /** Local-part of the `<sender>@<tenant>.local` address notification inbox rows are filed under. */
  notificationSender: string;
  /** The host session cookie the token handshake sets. */
  sessionCookie: string;
  /** The stdout line prefix the spawning shell waits for. */
  handshakePrefix: string;
  /** The inert JSON script id the served interface reads its hub origin from. */
  hubConfigScriptId: string;
  /** The `globalThis` key that holds the session token across `bun --hot` reloads. */
  globalTokenKey: string;
  /** Extra `connect-src` entries the CSP needs beyond `'self'`. */
  connectSrcExtra: string[];
  /** The command the "interface not built" 503 names. */
  interfaceBuildHint: string;
  /** The embedded workspace owner's account, minted once with a keychain password. */
  ownerEmail: string;
  /** Display name when the signed-in profile has none. */
  ownerName: string;
  /** The tenant slug this product's workspace carries. */
  workspaceSlug: string;
  /** The tenant id workspaces carried before the hub owned identity. */
  legacyTenantId: string;
}

let identity: HostIdentity | null = null;

export function initHost(next: HostIdentity): void {
  if (identity) throw new Error("initHost has already run for this process.");
  identity = next;
  // The keychain store is product-agnostic too, so the same declaration
  // configures it — one init call is the whole contract.
  configureKeychain({
    service: next.keychainService,
    envPrefix: next.envPrefix,
    dataDirectory,
  });
}

export function hostIdentity(): HostIdentity {
  if (!identity) {
    throw new Error("initHost has not run — the host entrypoint declares the product identity first.");
  }
  return identity;
}
