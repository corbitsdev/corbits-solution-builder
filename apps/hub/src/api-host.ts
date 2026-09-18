import { access, rm, writeFile } from "node:fs/promises";
import type { Hono } from "hono";
import { startAtLoginMarker } from "./paths.js";
import { designerSettings, saveDesignerSettings, type DesignerSettings } from "./designer-settings.js";
import { deckSettings, saveDeckDesign, type DeckDesign } from "./deck-settings.js";
import { removeTemplate, storeTemplate } from "./deck-template.js";
import { HostError } from "./errors.js";
import { COMMANDS, LEDGER, STAGE_TITLES } from "@solutions-builder/app/ledger";
import { AGENT_KIT } from "@solutions-builder/app/kit";
import { listProviders } from "./providers.js";
import { credentialBackend } from "./host-secrets.js";
import { hostStatus, requestHostStop } from "./lifecycle.js";
import { ensureHub, HubApiError, hubFetch } from "./hub-client.js";
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
    // Inference listing talks to hub catalog routes. A hosted product still
    // has to answer GET /api/status; Interchange 401/403 is "none connected",
    // not an internal error.
    const providers = await listProviders().catch((cause: unknown) => {
      if (cause instanceof HubApiError && (cause.status === 401 || cause.status === 403)) return [];
      throw cause;
    });
    return context.json({
      apiVersion: API_VERSION,
      host: hostStatus(),
      credentialBackend: await credentialBackend(),
      inference: {
        connected: providers.some((provider) => provider.status === "ready"),
        active: providers.find((provider) => provider.active)?.providerId ?? null,
      },
      ...sidecarFacts(),
      hub: await hubSummary(),
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

  api.post("/host/stop", async (context) => {
    // An explicit host stop, distinct from closing a window.
    requestHostStop();
    return context.json({ stopping: true });
  });

  /**
   * Two kinds of preference, neither in the database. Start-at-login lives
   * in a marker file the desktop host reads before the database is open;
   * its presence is the opt-in. The designer's settings live in a file of
   * their own and are read once per design, as `designer.*` keys here.
   */
  api.get("/preferences", async (context) => {
    const startAtLogin = await access(startAtLoginMarker())
      .then(() => true)
      .catch(() => false);
    const designer = Object.fromEntries(
      Object.entries(await designerSettings()).map(([key, value]) => [`designer.${key}`, value]),
    );
    const decks = Object.fromEntries(
      Object.entries(await deckSettings()).flatMap(([role, design]) =>
        Object.entries(design).map(([key, value]) => [`deck.${role}.${key}`, value]),
      ),
    );
    return context.json({ preferences: { "host.startAtLogin": startAtLogin, ...designer, ...decks } });
  });

  /**
   * A role's style guide: a PowerPoint whose theme — colours, typefaces,
   * slide size — the role's decks are drawn with. Sent as multipart `file`.
   */
  api.post("/deck-settings/:role/template", async (context) => {
    const role = context.req.param("role");
    const form = await context.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) throw new HostError("validation_failed", "Send the PowerPoint as multipart form data under `file`.");
    const theme = await storeTemplate(role, { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    const design = await saveDeckDesign(role, { template: file.name });
    return context.json({ role, design, theme });
  });

  api.delete("/deck-settings/:role/template", async (context) => {
    const role = context.req.param("role");
    await removeTemplate(role);
    const design = await saveDeckDesign(role, { template: null });
    return context.json({ role, design });
  });

  api.put("/preferences/:key", async (context) => {
    const key = context.req.param("key");
    const value = await context.req.json();

    if (key === "host.startAtLogin") {
      const marker = startAtLoginMarker();
      if (value === true) await writeFile(marker, "1");
      else await rm(marker, { force: true });
    } else if (key.startsWith("designer.")) {
      const field = key.slice("designer.".length) as keyof DesignerSettings;
      const saved = await saveDesignerSettings({ [field]: value } as Partial<DesignerSettings>);
      return context.json({ key, value: saved[field] });
    } else if (key.startsWith("deck.")) {
      // `deck.<role>.<field>`: one role's design, one field at a time.
      const [role, field] = key.slice("deck.".length).split(".") as [string, keyof DeckDesign];
      const saved = await saveDeckDesign(role, { [field]: value } as Partial<DeckDesign>);
      return context.json({ key, value: saved[field] });
    }
    return context.json({ key, value });
  });
}
