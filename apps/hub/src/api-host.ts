import type { Hono } from "hono";
import {
  credentialBackend,
  dataDirectory,
  ensureHub,
  hostStatus,
  mintOwnerSetCookie,
  sidecarFacts,
} from "@corbits/embedded-host";

export const API_VERSION = "1";

export function registerHostRoutes(api: Hono) {
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
