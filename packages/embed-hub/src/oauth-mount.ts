/**
 * Provider sign-in mounted on the embedded hub's own app: PKCE + loopback
 * OAuth login through `@corbits/oauth-core`, configured for the providers
 * `@corbits/codex-provider` and `@corbits/xai-provider` supply. The hub
 * process runs on the same machine as the signed-in operator (embedded in
 * the desktop host), so the loopback callback binds locally exactly as a
 * CLI login would; a client only needs the authorize URL to open and a
 * status route to poll for the exchanged tokens.
 *
 * This module does not persist anything — storing the exchanged tokens as a
 * workspace credential is the client's job, the same way it already is for
 * an API key (`packages/installer/src/provider-connect.ts`).
 */
import type { Hono } from "hono";
import {
  buildAuthorizeUrl,
  openInBrowser,
  startCallbackServer,
  startOAuthLogin,
  type BaseTokens,
  type OAuthClientConfig,
} from "@corbits/oauth-core";
import { codexOAuthConfig, exchangeCodexCode } from "@corbits/codex-provider";
import { xaiOAuthConfig, exchangeXaiCode } from "@corbits/xai-provider";

export const MOUNTABLE_OAUTH_PROVIDERS = ["codex-oauth", "xai-oauth"] as const;
export type MountableOAuthProviderId = (typeof MOUNTABLE_OAUTH_PROVIDERS)[number];

type ProviderDefinition = {
  readonly config: OAuthClientConfig;
  readonly exchange: (code: string, verifier: string, now: number) => Promise<BaseTokens>;
};

const PROVIDERS: Readonly<Record<MountableOAuthProviderId, ProviderDefinition>> = {
  "codex-oauth": { config: codexOAuthConfig, exchange: exchangeCodexCode },
  "xai-oauth": { config: xaiOAuthConfig, exchange: exchangeXaiCode },
};

type LoginState =
  | { status: "pending" }
  | { status: "done"; tokens: BaseTokens }
  | { status: "error"; message: string };

/** Host and port `startCallbackServer` binds, parsed from the provider's fixed redirect URI. */
function callbackConfigFor(redirectUri: string): { host: string; port: number; path: string } {
  const url = new URL(redirectUri);
  return { host: url.hostname, port: Number(url.port), path: url.pathname };
}

/**
 * Mounts `POST /api/oauth/:providerId/start` and `GET /api/oauth/:providerId/status`
 * on `app`. Starting a login opens the operator's browser (via
 * `@corbits/oauth-core`'s default `openInBrowser`) and returns the same
 * authorize URL for a client that wants to offer it directly; the client
 * polls `status` for the exchanged tokens once the loopback redirect lands.
 * A login in flight for a provider is replaced by starting again.
 *
 * `openInBrowser` defaults to `@corbits/oauth-core`'s real one; a caller
 * (tests) can inject a no-op so starting a login never spawns a real
 * browser process.
 */
export function mountProviderOAuth(app: Hono, open: (url: string) => void = openInBrowser): void {
  const logins = new Map<MountableOAuthProviderId, LoginState>();

  app.post("/api/oauth/:providerId/start", async (c) => {
    const providerId = c.req.param("providerId");
    const definition = (PROVIDERS as Record<string, ProviderDefinition | undefined>)[providerId];
    if (!definition) {
      return c.json({ error: { code: "unknown_provider", message: `No OAuth provider named ${providerId}.` } }, 404);
    }
    const id = providerId as MountableOAuthProviderId;
    const { host, port, path } = callbackConfigFor(definition.config.redirectUri);

    logins.set(id, { status: "pending" });
    let authorizeUrl: string;
    try {
      const handle = await startOAuthLogin(
        { profile: id, signal: new AbortController().signal },
        {
          startCallbackServer: (state) =>
            startCallbackServer(state, {
              host,
              port,
              path,
              doneHtml: "<html><body>Signed in — you can close this tab.</body></html>",
              failedHtml: (reason) => `<html><body>Sign-in failed: ${reason}</body></html>`,
            }),
          buildAuthorizeUrl: (pkce, state) => buildAuthorizeUrl(definition.config, pkce, state),
          exchangeCode: (code, verifier, now) => definition.exchange(code, verifier, now),
          // Persistence is the client's job; staging here only tracks the
          // in-memory status a poller reads.
          saveProfile: async ({ tokens }) => {
            logins.set(id, { status: "done", tokens });
          },
          openInBrowser: open,
        },
      );
      authorizeUrl = handle.authorizeUrl;
      void handle.completed
        .then((staged) => staged.commit())
        .catch((cause) => {
          logins.set(id, { status: "error", message: cause instanceof Error ? cause.message : String(cause) });
        });
    } catch (cause) {
      logins.set(id, { status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      return c.json(
        { error: { code: "oauth_start_failed", message: cause instanceof Error ? cause.message : String(cause) } },
        502,
      );
    }
    return c.json({ authorizeUrl });
  });

  app.get("/api/oauth/:providerId/status", (c) => {
    const providerId = c.req.param("providerId");
    if (!(providerId in PROVIDERS)) {
      return c.json({ error: { code: "unknown_provider", message: `No OAuth provider named ${providerId}.` } }, 404);
    }
    const id = providerId as MountableOAuthProviderId;
    const state = logins.get(id);
    if (!state) return c.json({ status: "idle" as const });
    if (state.status === "done") {
      // One-shot: the client consumes the tokens once, then the next login
      // starts clean rather than replaying a stale success.
      logins.delete(id);
      return c.json({ status: "done" as const, tokens: state.tokens });
    }
    if (state.status === "error") {
      logins.delete(id);
      return c.json({ status: "error" as const, message: state.message });
    }
    return c.json({ status: "pending" as const });
  });
}
