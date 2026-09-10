import { access, rm, writeFile } from "node:fs/promises";
import type { Hono } from "hono";
import { startAtLoginMarker } from "./paths.js";
import { COMMANDS, LEDGER, STAGE_TITLES } from "@solutions-builder/app/ledger";
import { AGENT_KIT } from "@solutions-builder/app/kit";
import { listProviders } from "./providers.js";
import { credentialBackend } from "./provider-credentials.js";
import { BRIDGE_CAPABILITIES, BRIDGE_ID, bridgeAvailable } from "./corbits-exec.js";
import { hostStatus, requestHostStop } from "./lifecycle.js";
import { ensureHub, hubFetch } from "./hub-client.js";
import { install, installState } from "./install.js";

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
    const providers = await listProviders();
    const bridge = await bridgeAvailable();
    return context.json({
      apiVersion: API_VERSION,
      host: hostStatus(),
      credentialBackend: await credentialBackend(),
      inference: {
        connected: providers.some((provider) => provider.status === "ready"),
        active: providers.find((provider) => provider.active)?.providerId ?? null,
      },
      hub: await hubSummary(),
      build: {
        // Named honestly: this is the bounded bridge, not shared-hub supervision.
        integration: BRIDGE_ID,
        available: bridge.available,
        detail: bridge.detail,
        capabilities: BRIDGE_CAPABILITIES,
      },
    });
  });

  /** The ledger, served to clients so labels and available actions agree with it. */
  api.get("/ledger", (context) =>
    context.json({
      commands: COMMANDS,
      stages: Object.entries(STAGE_TITLES).map(([stage, title]) => ({
        stage: Number(stage),
        title,
      })),
      transitions: LEDGER,
    }),
  );

  api.get("/agents", (context) =>
    context.json({
      agents: AGENT_KIT.map((agent) => ({
        id: agent.id,
        title: agent.title,
        mission: agent.mission,
        stages: agent.stages,
        produces: agent.produces,
        promptKey: agent.promptKey,
        boundary: agent.boundary,
      })),
    }),
  );

  /**
   * The client is the installer: it reads this on launch and asks for an
   * install when the tenant is missing definitions or holds an older version.
   * Idempotent, so it is also asked after any credential change.
   */
  api.get("/install", async (context) => context.json(await installState()));
  api.post("/install", async (context) => context.json(await install()));

  api.post("/host/stop", async (context) => {
    // An explicit host stop, distinct from closing a window.
    requestHostStop();
    return context.json({ stopping: true });
  });

  /**
   * The only host preference left is start-at-login, and it lives in a
   * marker file, not the database — the desktop host reads it before the
   * database is open. Its presence is the opt-in; absence is off.
   */
  api.get("/preferences", async (context) => {
    const startAtLogin = await access(startAtLoginMarker())
      .then(() => true)
      .catch(() => false);
    return context.json({ preferences: { "host.startAtLogin": startAtLogin } });
  });

  api.put("/preferences/:key", async (context) => {
    const key = context.req.param("key");
    const value = await context.req.json();

    if (key === "host.startAtLogin") {
      const marker = startAtLoginMarker();
      if (value === true) await writeFile(marker, "1");
      else await rm(marker, { force: true });
    }
    return context.json({ key, value });
  });
}
