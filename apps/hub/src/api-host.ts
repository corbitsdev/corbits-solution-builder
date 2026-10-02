import type { Hono } from "hono";
import {
  credentialBackend,
  HostError,
  dataDirectory,
  ensureHub,
  hostIdentity,
  hostStatus,
  mintOwnerSetCookie,
  readSecretResult,
  recoverTenantDeployments,
  secretReference,
  sidecarFacts,
  storeSecret,
  mountGoogleDrive,
  type GoogleSecretStore,
} from "@corbits/embedded-host";

/**
 * The Google Drive connection's client and tokens live in the OS keychain
 * beside the host's own secrets (#233). The keychain has no delete, so a
 * forgotten secret is written empty, which the store reads as absent.
 */
export const keychainSecretStore: GoogleSecretStore = {
  async read(account) {
    const read = await readSecretResult(await secretReference(account));
    if (read.status === "found") return read.secret === "" ? null : read.secret;
    if (read.status === "missing") return null;
    throw new Error(`The keychain could not be read: ${read.detail}`);
  },
  async write(account, value) {
    await storeSecret(account, value);
  },
};

export const API_VERSION = "1";

export function registerHostRoutes(api: Hono, secrets: GoogleSecretStore = keychainSecretStore) {
  // One click from a stakeholder's slides to Google Slides: the connection
  // and the upload live here, so nothing of Google's reaches the browser.
  mountGoogleDrive(api, hostIdentity().oauthPageCopy, secrets);

  api.get("/status", async (context) => {
    // Connected inference is read straight from the hub catalog routes by
    // the client (apps/web/src/provider-catalog.ts); this host no longer
    // vouches for it.
    return context.json({
      apiVersion: API_VERSION,
      host: hostStatus(),
      credentialBackend: await credentialBackend(),
      dataDir: dataDirectory(),
      ...sidecarFacts(),
      // What this host knows about the hub: which mode it is in, where it
      // is, and why embedded start failed when it did. Whether the hub is
      // actually answering is the client's own read — it has a transport
      // straight to the hub and does not need this host to relay health.
      hub: await ensureHub().catch((cause: unknown) => ({
        mode: "embedded" as const,
        url: null,
        ready: false,
        detail: cause instanceof Error ? cause.message : "The hub did not start.",
      })),
    });
  });

  /**
   * A project is being opened: place the named deployments of its that died
   * with a previous host again, rather than deploying new ones (CL-9700). A
   * project is its own tenant, so the id is the tenant's; the page names the
   * deployments it would otherwise redeploy. Answers the ids being placed;
   * the page waits for them before it ensures anything. A remote hub places
   * its own sidecars and answers nothing here.
   */
  api.post("/projects/:projectId/recover-deployments", async (context) => {
    const projectId = context.req.param("projectId");
    if (!/^tnt_[0-9a-f]+$/.test(projectId)) throw new HostError("validation_failed", "A project id names a tenant.");
    const body: unknown = await context.req.json().catch(() => null);
    const ids = body !== null && typeof body === "object" ? (body as { deploymentIds?: unknown }).deploymentIds : undefined;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && /^run_[0-9a-f]+$/.test(id))) {
      throw new HostError("validation_failed", "deploymentIds names the deployments to place again.");
    }
    return context.json({ deploymentIds: await recoverTenantDeployments(projectId, ids) });
  });

  /**
   * Mints the embedded workspace owner and signs the browser in as them, by
   * setting Better Auth's own session cookie on this response. First-run for
   * a local desktop: no sign-up form, one local account, its password only
   * ever in the keychain (`hub-client.ts`'s `mintOwnerSetCookie`). Refuses
   * for a remote hub — that account flow is the browser's own
   * `/api/auth/*` calls against the real hub.
   */
  api.post("/owner/session", async (context) => {
    for (const cookie of await mintOwnerSetCookie()) {
      context.header("set-cookie", cookie, { append: true });
    }
    return context.json({ ok: true });
  });
}
