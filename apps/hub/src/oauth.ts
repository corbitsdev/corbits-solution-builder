/**
 * OAuth sessions — read side.
 *
 * Signing in and disconnecting are now the client's job, over `/hub`'s
 * credential routes; the interactive loopback flow that used to live here
 * (`beginLogin`/`completeLogin`) had no hub equivalent (it needs a local
 * browser and a bound loopback port) and its UI affordance is gone with it.
 *
 * What stays is what the host's own inference execution still needs: a
 * refreshed access token for a connected OAuth credential, built on
 * `@corbits/oauth-core`'s refresh coalescing so a rotating refresh token is
 * never raced. Persistence goes through `catalog.ts` into Interchange's own
 * credential row — the same store an API key lands in.
 */
import { createTokenSession, type OAuthClientConfig } from "@corbits/oauth-core";
import {
  codexOAuthConfig,
  refreshCodexTokens,
  CODEX_BASE_URL,
  CODEX_REFRESH_SKEW_MS,
  type CodexTokens,
} from "@corbits/codex-provider";
import {
  refreshXaiTokens,
  xaiOAuthConfig,
  XAI_OAUTH_PROXY_BASE_URL,
  XAI_REFRESH_SKEW_MS,
  type XaiTokens,
} from "@corbits/xai-provider";
import { HostError } from "./errors.js";
import { credentialSecretFor, setCredentialSecret } from "./catalog.js";

export const OAUTH_PROVIDERS = ["codex-oauth", "xai-oauth"] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

type Tokens = CodexTokens | XaiTokens;

type Definition = {
  readonly id: OAuthProviderId;
  readonly label: string;
  readonly config: OAuthClientConfig;
  readonly skewMs: number;
  readonly baseUrl: string;
};

export const DEFINITIONS: Readonly<Record<OAuthProviderId, Definition>> = {
  "codex-oauth": {
    id: "codex-oauth",
    label: "ChatGPT (Codex)",
    config: codexOAuthConfig,
    skewMs: CODEX_REFRESH_SKEW_MS,
    baseUrl: CODEX_BASE_URL,
  },
  "xai-oauth": {
    id: "xai-oauth",
    label: "xAI (Grok)",
    config: xaiOAuthConfig,
    skewMs: XAI_REFRESH_SKEW_MS,
    baseUrl: XAI_OAUTH_PROXY_BASE_URL,
  },
};

/**
 * The connected provider's own catalog id — `codex-oauth` / `xai-oauth` are
 * already the `providerId` `catalog.ts` names a credential row by
 * (`provider:codex-oauth`), so no separate account scheme is needed.
 */
async function loadTokens(id: OAuthProviderId): Promise<Tokens | undefined> {
  // No credential row (never signed in) reads the same as absent —
  // `credentialSecretFor` returns `null` for that case without throwing.
  let secret: string | null;
  try {
    secret = await credentialSecretFor(id);
  } catch (cause) {
    // A thrown failure here means the credential row exists but its secret
    // could not be resolved — a decrypt error, a hub the resolver could not
    // reach — not "never signed in". Swallowing it as a plain absence would
    // read as a silent logout on a transient fault, so it is reported loudly
    // even though the caller still sees "no session" rather than a crash.
    console.error(
      `[oauth] the ${id} credential could not be resolved, treating this check as ` +
        `no session rather than failing it: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return undefined;
  }
  if (secret === null) return undefined;

  try {
    return JSON.parse(secret) as Tokens;
  } catch {
    // Stored, but not a token this build understands: a re-login is the fix,
    // and that reads the same as no session.
    return undefined;
  }
}

/** Rewrites the credential row's sealed tokens in place after a refresh. */
async function saveTokens(id: OAuthProviderId, tokens: Tokens): Promise<void> {
  await setCredentialSecret(id, JSON.stringify(tokens));
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
      return id === "codex-oauth"
        ? refreshCodexTokens(refreshToken, now, previous as CodexTokens)
        : refreshXaiTokens(refreshToken, now);
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
