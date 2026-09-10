import type { Hono } from "hono";
import { HostError } from "./errors.js";
import { ProviderConnectRequest } from "./domain.js";
import {
  API_KEY_PROVIDERS,
  OAUTH_CANDIDATES,
  connectProvider,
  disconnectProvider,
  listProviders,
  selectModel,
  startOAuthConnect,
  finishOAuthConnect,
  refreshProviderModels,
  setProviderOrder,
} from "./providers.js";
import { cancelLogin, loginInFlight } from "./oauth.js";
import { parsed } from "./api.js";

export function registerProviderRoutes(api: Hono) {
  api.get("/providers", async (context) =>
    context.json({
      // `hasCredential` is a boolean. The secret itself has no route.
      providers: await listProviders(),
      apiKeyProviders: API_KEY_PROVIDERS,
      oauthCandidates: OAUTH_CANDIDATES,
    }),
  );

  api.post("/providers", async (context) => {
    const request = parsed(ProviderConnectRequest(await context.req.json()));
    const provider = await connectProvider(request);
    return context.json({ provider });
  });

  /**
   * Starts a browser sign-in. Returns the authorize URL so the UI can offer it
   * as a copyable link when the browser could not be launched.
   */
  api.post("/providers/oauth/:providerId/start", async (context) =>
    context.json(await startOAuthConnect(context.req.param("providerId"))),
  );

  /** Waits for the loopback callback and records the connection. */
  api.post("/providers/oauth/finish", async (context) =>
    context.json({ provider: await finishOAuthConnect() }),
  );

  api.post("/providers/oauth/cancel", async (context) => {
    cancelLogin();
    return context.json({ cancelled: true });
  });

  api.get("/providers/oauth/status", (context) =>
    context.json({ inFlight: loginInFlight() }),
  );

  api.put("/providers/order", async (context) => {
    const body = (await context.req.json()) as { providerIds?: string[] };
    if (!Array.isArray(body.providerIds)) {
      throw new HostError("validation_failed", "Send the provider ids in their new order.");
    }
    return context.json({ providers: await setProviderOrder(body.providerIds) });
  });

  api.post("/providers/:providerId/refresh", async (context) =>
    context.json({ provider: await refreshProviderModels(context.req.param("providerId")) }),
  );

  api.put("/providers/:providerId/model", async (context) => {
    const body = (await context.req.json()) as { model?: string };
    if (!body.model) throw new HostError("validation_failed", "Name a model.");
    const provider = await selectModel(context.req.param("providerId"), body.model);
    return context.json({ provider });
  });

  api.delete("/providers/:providerId", async (context) => {
    await disconnectProvider(context.req.param("providerId"));
    return context.json({ ok: true });
  });
}
