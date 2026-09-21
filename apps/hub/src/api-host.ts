import type { Hono } from "hono";
import { credentialBackend } from "./host-secrets.js";
import { hostStatus } from "./lifecycle.js";
import { ensureHub, hubFetch, mintOwnerSetCookie } from "./hub-client.js";
import { sidecarFacts } from "./hub-mount.js";

export const API_VERSION = "1";

/**
 * What the interface says about the hub. `mode` is the whole point of the
 * seam: the same product runs against an embedded hub today and a hosted one
 * later, and this is where that becomes visible rather than implied.
 */
async function hubSummary() {
  const endpoint = await ensureHub().catch((cause: unknown) => ({
    mode: "embedded" as const,
    url: null,
    ready: false,
    detail: cause instanceof Error ? cause.message : "The hub did not start.",
  }));

  // The hub reports its own health; this host does not vouch for it.
  const status = await hubFetch("/status")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);

  return {
    mode: endpoint.mode,
    url: endpoint.url,
    ready: endpoint.ready && status !== null,
    detail: endpoint.detail,
    reported: status,
  };
}

export function registerHostRoutes(api: Hono) {
  api.get("/status", async (context) => {
    // Connected inference is read straight from the hub catalog routes by
    // the client (apps/web/src/provider-catalog.ts); this host no longer
    // vouches for it.
    return context.json({
      apiVersion: API_VERSION,
      host: hostStatus(),
      credentialBackend: await credentialBackend(),
      ...sidecarFacts(),
      hub: await hubSummary(),
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
