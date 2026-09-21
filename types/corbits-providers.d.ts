/**
 * Local declarations for the corbitsdev provider packages.
 *
 * They ship TypeScript source and type themselves against `@intx/inference`'s
 * adapter surface, which this build does not consume — Solutions Builder uses
 * their OAuth configuration and wire quirks, not their `AdapterFactory`. Their
 * sources therefore do not compile inside this project's program, and
 * typechecking a dependency's internals was never the goal.
 *
 * Declaring the surface actually imported keeps `bun run typecheck` about this
 * repository's code. Verified against the pinned revisions in `bun.lock`.
 */
declare module "@corbits/oauth-core" {
  /** Best-effort: opens a URL in the person's default browser, never throws.
   *  The package's own opener — a caller that omits it leaves the person to
   *  copy the authorize link by hand. */
  export function openInBrowser(url: string): void;

  export type BaseTokens = { access: string; refresh: string; expiresAt?: number };
  export type AuthProfile<T> = { name: string; tokens: T; createdAt: number };
  export type Pkce = { verifier: string; challenge: string; method: "S256" };

  export type OAuthClientConfig = {
    clientId: string;
    authorizeUrl: string;
    tokenUrl: string;
    redirectUri: string;
    scopes: readonly string[];
    extraAuthorizeParams?: Record<string, string>;
  };

  export type CallbackServer = {
    port?: number;
    waitForCode: (signal: AbortSignal) => Promise<string>;
    close: () => void;
  };

  export type CallbackServerConfig = {
    port: number;
    host?: string;
    path: string;
    doneHtml: string;
    failedHtml: (reason: string) => string;
  };

  export function startCallbackServer(
    expectedState: string,
    config: CallbackServerConfig,
  ): Promise<CallbackServer>;

  export function buildAuthorizeUrl(
    config: OAuthClientConfig,
    pkce: Pkce,
    state: string,
  ): string;

  export type StagedOAuthProfile<T extends BaseTokens> = {
    readonly profile: AuthProfile<T>;
    readonly commit: () => Promise<void>;
  };

  export type OAuthLoginHandle<T extends BaseTokens> = {
    authorizeUrl: string;
    completed: Promise<StagedOAuthProfile<T>>;
    cancel: () => void;
  };

  export function startOAuthLogin<T extends BaseTokens>(
    opts: { profile: string; signal: AbortSignal; now?: () => number },
    deps: {
      startCallbackServer: (expectedState: string) => Promise<CallbackServer>;
      buildAuthorizeUrl: (pkce: Pkce, state: string) => string;
      exchangeCode: (code: string, verifier: string, now: number) => Promise<T>;
      saveProfile: (profile: { name: string; tokens: T; createdAt: number }) => Promise<void>;
      openInBrowser?: (url: string) => void;
    },
  ): Promise<OAuthLoginHandle<T>>;

  export type TokenSession<T extends BaseTokens, A> = {
    isExpired: (tokens: T, now: number) => boolean;
    getValidToken: (name: string, now?: number) => Promise<A>;
  };

  export function createTokenSession<T extends BaseTokens, A>(deps: {
    skewMs: number;
    loadProfile: (name: string) => Promise<{ tokens: T } | undefined>;
    updateTokens: (name: string, tokens: T) => Promise<void>;
    refreshTokens: (refreshToken: string, now: number) => Promise<T>;
    toAccess: (tokens: T) => A;
    mergeRefreshed?: (refreshed: T, previous: T) => T;
  }): TokenSession<T, A>;
}

declare module "@corbits/codex-provider" {
  import type { BaseTokens, OAuthClientConfig } from "@corbits/oauth-core";
  import type { AdapterFactory } from "@intx/inference";
  export const createCodexResponsesAdapter: AdapterFactory;
  export type CodexQuirks = { productName: string; environmentTagName: string };
  export function parseCodexQuirks(raw: unknown): CodexQuirks;
  export type CodexTokens = BaseTokens & { accountId?: string };
  export const codexOAuthConfig: OAuthClientConfig;
  export const CODEX_BASE_URL: string;
  export const CODEX_RESPONSES_PATH: string;
  export const CODEX_REDIRECT_URI: string;
  export const CODEX_REFRESH_SKEW_MS: number;
  export const CODEX_ACCOUNT_ID_OPTION: string;
  export const CODEX_SESSION_ID_OPTION: string;
  export function accountIdFromIdToken(idToken: string): string | undefined;
  export function exchangeCodexCode(
    code: string,
    verifier: string,
    now: number,
  ): Promise<CodexTokens>;
  export function refreshCodexTokens(
    refreshToken: string,
    now: number,
    previous: CodexTokens,
  ): Promise<CodexTokens>;
}

declare module "@corbits/xai-provider" {
  import type { BaseTokens, OAuthClientConfig } from "@corbits/oauth-core";
  import type { AdapterFactory } from "@intx/inference";
  export const createXaiResponsesAdapter: AdapterFactory;
  export type XaiTokens = BaseTokens & { idToken?: string };
  export const xaiOAuthConfig: OAuthClientConfig;
  export const xaiResponsesQuirks: unknown;
  export const XAI_OAUTH_PROXY_BASE_URL: string;
  export const XAI_REDIRECT_URI: string;
  export const XAI_REFRESH_SKEW_MS: number;
  export const XAI_API_KEY_BASE_URL: string;
  export const XAI_USER_ID_OPTION: string;
  export const XAI_SESSION_ID_OPTION: string;
  export function xaiUserIdFromAccessToken(access: string): string | undefined;
  export const XAI_DEFAULT_MODELS: readonly string[];
  export function exchangeXaiCode(
    code: string,
    verifier: string,
    now: number,
  ): Promise<XaiTokens>;
  export function refreshXaiTokens(refreshToken: string, now: number): Promise<XaiTokens>;
}
