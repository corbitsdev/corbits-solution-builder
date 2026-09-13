/**
 * OAuth login — BUILD_PLAN_V3 section 5, PRD section 6.
 *
 * Built on the corbitsdev libraries rather than a reimplementation:
 *
 *   `@corbits/oauth-core`      PKCE S256, the loopback callback server, the
 *                              token exchange, and refresh coalescing.
 *   `@corbits/xai-provider`    xAI/Grok issuer configuration and token mapping.
 *   `@corbits/codex-provider`  Login-with-ChatGPT configuration and token mapping.
 *
 * What stays here is what the plan says the *host* owns and the libraries
 * explicitly do not: secure persistence, session lifecycle, cancellation,
 * logout, and provider policy. oauth-core is not a credential vault, so tokens
 * go to the OS keychain through `credentials.ts` and never touch a row, a
 * response body, a log line, an artifact or a prompt.
 */
import {
  buildAuthorizeUrl,
  createTokenSession,
  startCallbackServer,
  startOAuthLogin,
  type BaseTokens,
  type OAuthClientConfig,
  type OAuthLoginHandle,
} from "@corbits/oauth-core";
import {
  codexOAuthConfig,
  exchangeCodexCode,
  refreshCodexTokens,
  CODEX_BASE_URL,
  CODEX_REDIRECT_URI,
  CODEX_REFRESH_SKEW_MS,
  type CodexTokens,
} from "@corbits/codex-provider";
import {
  exchangeXaiCode,
  refreshXaiTokens,
  xaiOAuthConfig,
  XAI_DEFAULT_MODELS,
  XAI_OAUTH_PROXY_BASE_URL,
  XAI_REDIRECT_URI,
  XAI_REFRESH_SKEW_MS,
  type XaiTokens,
} from "@corbits/xai-provider";
import { HostError } from "./errors.js";
import {
  authorizationDoneHtml,
  callbackPageHtml,
  type CallbackPageCopy,
} from "./oauth-page.js";
import { deleteSecret, readSecretResult, secretReference, storeSecret } from "./provider-credentials.js";

export const OAUTH_PROVIDERS = ["codex-oauth", "xai-oauth"] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

type Tokens = CodexTokens | XaiTokens;

type Definition = {
  readonly id: OAuthProviderId;
  readonly label: string;
  readonly config: OAuthClientConfig;
  readonly redirectUri: string;
  readonly skewMs: number;
  readonly baseUrl: string;
  /**
   * Last-resort catalogue, used only when live discovery fails. Model families
   * move fast; a hardcoded list is stale the week it is written, so this is a
   * fallback and never the source.
   */
  readonly fallbackModels: readonly string[];
  /** Asks the provider what it actually serves. */
  readonly discoverModels?: (accessToken: string, accountId?: string) => Promise<string[]>;
  readonly exchange: (code: string, verifier: string, now: number) => Promise<Tokens>;
  readonly refresh: (refreshToken: string, now: number, previous: Tokens) => Promise<Tokens>;
};

export const DEFINITIONS: Readonly<Record<OAuthProviderId, Definition>> = {
  "codex-oauth": {
    id: "codex-oauth",
    label: "ChatGPT (Codex)",
    config: codexOAuthConfig,
    redirectUri: CODEX_REDIRECT_URI,
    skewMs: CODEX_REFRESH_SKEW_MS,
    baseUrl: CODEX_BASE_URL,
    fallbackModels: ["gpt-5.5"],
    discoverModels: discoverCodexModels,
    exchange: (code, verifier, now) => exchangeCodexCode(code, verifier, now),
    refresh: (refreshToken, now, previous) =>
      refreshCodexTokens(refreshToken, now, previous as CodexTokens),
  },
  "xai-oauth": {
    id: "xai-oauth",
    label: "xAI (Grok)",
    config: xaiOAuthConfig,
    redirectUri: XAI_REDIRECT_URI,
    skewMs: XAI_REFRESH_SKEW_MS,
    baseUrl: XAI_OAUTH_PROXY_BASE_URL,
    fallbackModels: [...XAI_DEFAULT_MODELS],
    discoverModels: discoverXaiModels,
    exchange: (code, verifier, now) => exchangeXaiCode(code, verifier, now),
    refresh: (refreshToken, now) => refreshXaiTokens(refreshToken, now),
  },
};

/**
 * The models a ChatGPT account can actually drive through the Codex backend.
 *
 * `/backend-api/models` lists everything the account sees, in two spellings.
 * Only the `-wm` entries are accepted by the Responses endpoint, and the name
 * it wants is that slug with the suffix removed — `gpt-5.6-sol-wm` is served as
 * `gpt-5.6-sol`. The other spellings (`gpt-5-6`, and the bare `-wm` slug) are
 * both refused with "not supported when using Codex with a ChatGPT account".
 * Verified against the live backend; the rule is why this is discovered rather
 * than listed.
 */
async function discoverCodexModels(accessToken: string, accountId?: string): Promise<string[]> {
  const response = await fetch("https://chatgpt.com/backend-api/models", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`models endpoint answered ${response.status}`);
  const body = (await response.json()) as { models?: { slug?: string }[] };
  const models = (body.models ?? [])
    .map((entry) => entry.slug ?? "")
    .filter((slug) => slug.endsWith("-wm"))
    .map((slug) => slug.slice(0, -"-wm".length));
  if (models.length === 0) throw new Error("no Codex-capable models were listed");
  return models;
}

/** xAI publishes a standard OpenAI-shaped catalogue on its proxy. */
async function discoverXaiModels(accessToken: string): Promise<string[]> {
  const response = await fetch(`${XAI_OAUTH_PROXY_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`models endpoint answered ${response.status}`);
  const body = (await response.json()) as { data?: { id?: string }[] };
  const models = (body.data ?? []).map((entry) => entry.id ?? "").filter(Boolean);
  if (models.length === 0) throw new Error("no models were listed");
  return models;
}

/** The loopback port and path each issuer's redirect is registered against. */
function callbackFor(definition: Definition): { port: number; host: string; path: string } {
  const url = new URL(definition.redirectUri);
  return {
    port: Number(url.port),
    // The issuer's registered redirect decides the host: Codex registers
    // `localhost`, xAI registers `127.0.0.1`, and they are not interchangeable
    // to a strict redirect-URI comparison.
    host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname,
    path: url.pathname,
  };
}

export const PAGE_COPY: CallbackPageCopy = {
  productName: "Solutions Builder",
  siteUrl: "https://corbits.dev",
  siteLabel: "corbits.dev",
  githubUrl: "https://github.com/corbitsdev/solutions-builder-alpha",
  githubLabel: "github.com/corbitsdev/solutions-builder-alpha",
};

const credentialAccount = (id: OAuthProviderId) => `oauth:${id}`;

async function loadTokens(id: OAuthProviderId): Promise<Tokens | undefined> {
  const read = await readSecretResult(await secretReference(credentialAccount(id)));

  // A keychain that cannot answer is not a person who never signed in. Treated
  // as absence, a locked keychain silently signs somebody out and offers them
  // the login they already completed.
  if (read.status === "unavailable") {
    throw new HostError(
      "not_authorized",
      `The keychain could not be read for ${id}: ${read.detail}. ` +
        "Unlock it, or allow this app access, and try again — you are still signed in.",
    );
  }
  if (read.status === "missing") return undefined;

  try {
    return JSON.parse(read.secret) as Tokens;
  } catch {
    // Stored, but not a token this build understands: a re-login is the fix,
    // and that is what `undefined` asks for.
    return undefined;
  }
}

async function saveTokens(id: OAuthProviderId, tokens: Tokens): Promise<string> {
  return storeSecret(credentialAccount(id), JSON.stringify(tokens));
}

/**
 * One in-flight login at a time, held so `cancel` can abort the browser wait
 * and close the callback server. A stale callback cannot resurrect a cancelled
 * session, because the abort tears the server down before it can be hit.
 */
type Pending = {
  id: OAuthProviderId;
  handle: OAuthLoginHandle<BaseTokens>;
  controller: AbortController;
};
let pending: Pending | null = null;

export function loginInFlight(): OAuthProviderId | null {
  return pending?.id ?? null;
}

export type LoginStarted = { providerId: OAuthProviderId; authorizeUrl: string };

/**
 * Starts a browser login. Resolves as soon as the authorize URL exists so the
 * UI can show "waiting for the browser" rather than blocking; `completeLogin`
 * awaits the callback.
 */
export async function beginLogin(id: OAuthProviderId): Promise<LoginStarted> {
  const definition = DEFINITIONS[id];
  if (!definition) throw new HostError("validation_failed", `Unknown OAuth provider: ${id}.`);

  cancelLogin();
  const controller = new AbortController();
  const callback = callbackFor(definition);

  const handle = await startOAuthLogin<BaseTokens>(
    { profile: id, signal: controller.signal },
    {
      startCallbackServer: (expectedState) =>
        startCallbackServer(expectedState, {
          port: callback.port,
          host: callback.host,
          path: callback.path,
          // The callback page lands before the exchange and model discovery
          // finish, so it reports the authorization received, not a completed
          // connection — the app closes out the setup.
          doneHtml: authorizationDoneHtml(definition.label, PAGE_COPY),
          failedHtml: (reason) =>
            callbackPageHtml({ subject: definition.label, error: reason }, PAGE_COPY),
        }),
      buildAuthorizeUrl: (pkce, state) =>
        buildAuthorizeUrl(definition.config, pkce, state),
      exchangeCode: (code, verifier, now) =>
        definition.exchange(code, verifier, now) as Promise<BaseTokens>,
      // The host owns persistence; oauth-core only tells us when to do it.
      saveProfile: async ({ tokens }) => {
        await saveTokens(id, tokens as Tokens);
      },
      // The host opens the browser itself so a launch failure is reportable.
      openInBrowser: () => undefined,
    },
  ).catch((cause: unknown) => {
    throw translate(cause, definition);
  });

  pending = { id, handle, controller };
  return { providerId: id, authorizeUrl: handle.authorizeUrl };
}

/** Opens the system browser, reporting a launch failure rather than hanging. */
export function openBrowser(url: string): { opened: boolean; detail: string } {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const result = Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" });
  return result.exitCode === 0
    ? { opened: true, detail: "" }
    : {
        opened: false,
        detail:
          "The browser could not be opened automatically. Copy the sign-in link and open it yourself.",
      };
}

/** Waits for the callback, then commits the tokens to secure storage. */
export async function completeLogin(): Promise<{
  providerId: OAuthProviderId;
  credentialRef: string;
  models: string[];
  baseUrl: string;
  expiresAt: number;
}> {
  const current = pending;
  if (!current) throw new HostError("conflict", "No sign-in is in progress.");
  const definition = DEFINITIONS[current.id];

  try {
    const staged = await current.handle.completed;
    await staged.commit();
    const tokens = staged.profile.tokens as Tokens;

    // Ask the provider what it serves. A discovery failure is not a login
    // failure, so the fallback applies and the session still completes.
    let models = [...definition.fallbackModels];
    if (definition.discoverModels) {
      models = await definition
        .discoverModels(tokens.access, (tokens as { accountId?: string }).accountId)
        .catch(() => [...definition.fallbackModels]);
    }

    return {
      providerId: current.id,
      credentialRef: await secretReference(credentialAccount(current.id)),
      models,
      baseUrl: definition.baseUrl,
      // `expiresAt` is optional on BaseTokens when the issuer omits
      // `expires_in`; 0 reads as "unknown", never as "never expires".
      expiresAt: tokens.expiresAt ?? 0,
    };
  } catch (cause) {
    throw translate(cause, definition);
  } finally {
    pending = null;
  }
}

export function cancelLogin(): void {
  if (!pending) return;
  // Aborting closes the callback server, so a late redirect finds nothing
  // listening rather than completing a session the user walked away from.
  pending.controller.abort();
  pending.handle.cancel();
  pending = null;
}

/**
 * A valid access token for an outbound request, refreshed transparently.
 * Concurrent callers share one refresh — oauth-core coalesces in-flight
 * refreshes so a rotating refresh token is not raced.
 */
const sessions = new Map<OAuthProviderId, ReturnType<typeof createTokenSession<Tokens, Tokens>>>();

function sessionFor(id: OAuthProviderId) {
  const existing = sessions.get(id);
  if (existing) return existing;
  const definition = DEFINITIONS[id];
  const session = createTokenSession<Tokens, Tokens>({
    skewMs: definition.skewMs,
    loadProfile: async (name) => {
      const tokens = await loadTokens(name as OAuthProviderId);
      return tokens ? { tokens } : undefined;
    },
    // Replacement refresh tokens are persisted before the call returns, so a
    // crash mid-rotation cannot leave the stored token behind the issuer's.
    updateTokens: async (name, tokens) => {
      await saveTokens(name as OAuthProviderId, tokens);
    },
    refreshTokens: async (refreshToken, now) => {
      const previous = (await loadTokens(id)) ?? ({ refresh: refreshToken } as Tokens);
      return definition.refresh(refreshToken, now, previous);
    },
    toAccess: (tokens) => tokens,
  });
  sessions.set(id, session);
  return session;
}

export async function accessTokenFor(id: OAuthProviderId): Promise<Tokens> {
  try {
    return await sessionFor(id).getValidToken(id);
  } catch (cause) {
    throw new HostError(
      "not_authorized",
      `The ${DEFINITIONS[id].label} session could not be refreshed. Sign in again. ` +
        `(${cause instanceof Error ? cause.name : "unknown"})`,
      {},
      false,
    );
  }
}

/** Clears the local session. Provider-side revocation is not claimed. */
export async function logout(id: OAuthProviderId): Promise<{ revoked: false; detail: string }> {
  cancelLogin();
  sessions.delete(id);
  await deleteSecret(await secretReference(credentialAccount(id)));
  return {
    revoked: false,
    detail:
      `The local ${DEFINITIONS[id].label} session was cleared. ` +
      `Neither issuer publishes a revocation endpoint this host can call, so the ` +
      `token is not claimed to be revoked provider-side — revoke it in your account settings.`,
  };
}

/** Re-asks a connected provider what it serves, for the Settings refresh. */
export async function refreshModels(id: OAuthProviderId): Promise<string[]> {
  const definition = DEFINITIONS[id];
  if (!definition.discoverModels) return [...definition.fallbackModels];
  const tokens = await accessTokenFor(id);
  return definition.discoverModels(tokens.access, (tokens as { accountId?: string }).accountId);
}

export async function hasSession(id: OAuthProviderId): Promise<boolean> {
  return (await loadTokens(id)) !== undefined;
}

/** Maps library errors onto the host error contract with a safe message. */
function translate(cause: unknown, definition: Definition): HostError {
  const name = cause instanceof Error ? cause.name : "";
  const callback = callbackFor(definition);

  if (name === "OAuthCallbackPortInUseError") {
    return new HostError(
      "conflict",
      `Port ${callback.port} is already in use, and ${definition.label} only accepts a redirect ` +
        `on that exact port. Close whatever is using it and try again.`,
      {},
      true,
    );
  }
  if (name === "OAuthCallbackAddressUnavailableError") {
    return new HostError(
      "provider_unavailable",
      `The host could not bind ${callback.host}:${callback.port} for the sign-in callback.`,
    );
  }
  if (name === "OAuthTokenEndpointError" || name === "OAuthTokenResponseSchemaError") {
    return new HostError(
      "upstream_mismatch",
      `${definition.label} rejected the sign-in exchange. Nothing was stored.`,
    );
  }
  if (name === "OAuthMissingRefreshTokenError") {
    return new HostError(
      "upstream_mismatch",
      `${definition.label} returned no refresh token, so the session could not be kept alive.`,
    );
  }
  if (name === "AbortError" || (cause instanceof Error && /abort/i.test(cause.message))) {
    return new HostError("conflict", "The sign-in was cancelled. Nothing was stored.");
  }
  return new HostError(
    "provider_unavailable",
    `${definition.label} sign-in did not complete (${cause instanceof Error ? cause.message : "unknown error"}).`,
    {},
    true,
  );
}
