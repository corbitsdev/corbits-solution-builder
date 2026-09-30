/**
 * A Google Drive connection for the host, so a stakeholder's slides open in
 * Google Slides with one click (#233).
 *
 * Google gives no way to write a file to a person's Drive without an OAuth
 * client of their own, so the person creates one in Google Cloud Console
 * (type "Desktop app", with the Drive API enabled) and pastes its id and
 * secret here. The sign-in is the same PKCE + loopback flow the provider
 * sign-ins use (`oauth-mount.ts`, `@corbits/oauth-core`): the host binds a
 * loopback callback on a free port, opens the browser on Google's consent
 * page, and exchanges the code. A desktop client accepts any loopback port,
 * so nothing has to be registered. Google still wants the client secret at
 * the token endpoint for a desktop client, though it does not treat it as a
 * secret; `oauth-core`'s own exchange sends none, so the exchange here is
 * this module's.
 *
 * What is kept: the client (id and secret) and the tokens (a refresh token
 * that lasts, an access token that does not, and the account's email for
 * the settings page), both through the `SecretStore` the caller hands in.
 * The host backs it with the OS keychain. Nothing of Google's ever reaches
 * the browser: the interface posts the PowerPoint here, and this uploads it
 * with conversion to a Google Slides document and hands back the link.
 *
 * Routes are registered relative to `app`; the host mounts it under `/api`.
 */
import type { Env, Hono } from "hono";
import {
  buildAuthorizeUrl,
  openInBrowser,
  startCallbackServer,
  startOAuthLogin,
  type FetchLike,
  type OAuthClientConfig,
} from "@corbits/oauth-core";
import { authorizationDoneHtml, callbackPageHtml, type CallbackPageCopy } from "./oauth-page.js";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
/** Files this app creates, and who the person is; nothing else of their Drive. */
export const GOOGLE_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file", "openid", "email"] as const;
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const CALLBACK_PATH = "/google-drive/callback";
const TOKEN_TIMEOUT_MS = 20_000;
/** An access token this close to expiry is refreshed before use. */
const EXPIRY_MARGIN_MS = 60_000;

/** Where the connection is kept. */
export const CLIENT_ACCOUNT = "google-drive:client";
export const TOKENS_ACCOUNT = "google-drive:tokens";

export type GoogleClient = { readonly clientId: string; readonly clientSecret: string };
export type GoogleTokens = {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt?: number;
  readonly email?: string;
};

/** A small named-secret store; the host's is the OS keychain. An empty value reads as absent. */
export type SecretStore = {
  read(account: string): Promise<string | null>;
  write(account: string, value: string): Promise<void>;
};

export type GoogleDriveStatus = {
  readonly connected: boolean;
  readonly email: string | null;
  readonly clientId: string | null;
  readonly login: { status: "idle" } | { status: "pending" } | { status: "error"; message: string };
};

export function googleOAuthConfig(client: GoogleClient, redirectUri: string): OAuthClientConfig {
  return {
    clientId: client.clientId,
    authorizeUrl: GOOGLE_AUTHORIZE_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    redirectUri,
    scopes: GOOGLE_DRIVE_SCOPES,
    // A refresh token comes only for offline access, and only on a consent
    // Google actually shows; a repeat sign-in without `prompt=consent` hands
    // back no refresh token and the connection would die within the hour.
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
    tokenTimeoutMs: TOKEN_TIMEOUT_MS,
  };
}

/** The email claim of an OpenID id token, read without verification: it came straight from Google's token endpoint over TLS and is shown, never trusted. */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { email?: unknown };
    return typeof json.email === "string" ? json.email : undefined;
  } catch {
    return undefined;
  }
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
};

async function postGoogleToken(body: URLSearchParams, fetchImpl: FetchLike): Promise<TokenResponse> {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || typeof json.access_token !== "string") {
    const reason = typeof json.error_description === "string" ? json.error_description : typeof json.error === "string" ? json.error : `HTTP ${String(response.status)}`;
    throw new Error(`Google did not issue a token: ${reason}`);
  }
  return json;
}

export function googleTokensFromResponse(json: TokenResponse, now: number, previous?: GoogleTokens): GoogleTokens {
  const refresh = typeof json.refresh_token === "string" ? json.refresh_token : previous?.refresh;
  if (!refresh) throw new Error("Google issued no refresh token, so the connection would not outlast the hour. Try connecting again.");
  const email = emailFromIdToken(typeof json.id_token === "string" ? json.id_token : undefined) ?? previous?.email;
  return {
    access: json.access_token as string,
    refresh,
    ...(typeof json.expires_in === "number" ? { expiresAt: now + json.expires_in * 1000 } : {}),
    ...(email ? { email } : {}),
  };
}

export async function exchangeGoogleCode(
  client: GoogleClient,
  redirectUri: string,
  code: string,
  verifier: string,
  now: number,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  return googleTokensFromResponse(await postGoogleToken(body, fetchImpl), now);
}

export async function refreshGoogleTokens(client: GoogleClient, previous: GoogleTokens, now: number, fetchImpl: FetchLike = fetch): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: previous.refresh,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  return googleTokensFromResponse(await postGoogleToken(body, fetchImpl), now, previous);
}

/** Whether the access token needs refreshing before a call: expired, about to, or of unknown life. */
export function accessTokenStale(tokens: GoogleTokens, now: number): boolean {
  return tokens.expiresAt === undefined || tokens.expiresAt - now < EXPIRY_MARGIN_MS;
}

/**
 * The `multipart/related` body of a Drive upload that converts a PowerPoint
 * into a Google Slides document: the file's metadata names the target type,
 * the second part carries the bytes as PowerPoint.
 */
export function slidesUploadBody(name: string, pptx: Uint8Array, boundary: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: GOOGLE_SLIDES_MIME })}\r\n--${boundary}\r\ncontent-type: ${PPTX_MIME}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(new ArrayBuffer(head.length + pptx.length + tail.length));
  body.set(head, 0);
  body.set(pptx, head.length);
  body.set(tail, head.length + pptx.length);
  return body;
}

export type UploadedSlides = { readonly id: string; readonly url: string; readonly name: string };

/** Uploads the PowerPoint as a new Google Slides document and returns its link. Throws with Google's reason, and with `status` for a caller that retries a 401 after a refresh. */
export async function uploadAsGoogleSlides(access: string, name: string, pptx: Uint8Array, fetchImpl: FetchLike = fetch): Promise<UploadedSlides> {
  const boundary = `sb-${crypto.randomUUID()}`;
  const response = await fetchImpl(`${GOOGLE_UPLOAD_URL}?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: new Blob([slidesUploadBody(name, pptx, boundary)]),
  });
  const json = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown; webViewLink?: unknown; error?: { message?: unknown } };
  if (!response.ok || typeof json.id !== "string") {
    const reason = typeof json.error?.message === "string" ? json.error.message : `HTTP ${String(response.status)}`;
    throw new GoogleUploadError(response.status, reason);
  }
  return {
    id: json.id,
    name: typeof json.name === "string" ? json.name : name,
    url: typeof json.webViewLink === "string" ? json.webViewLink : `https://docs.google.com/presentation/d/${json.id}/edit`,
  };
}

export class GoogleUploadError extends Error {
  constructor(
    readonly status: number,
    reason: string,
  ) {
    super(`Google Drive refused the upload: ${reason}`);
    this.name = "GoogleUploadError";
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readClient(store: SecretStore): Promise<GoogleClient | null> {
  const client = parseJson<Partial<GoogleClient>>(await store.read(CLIENT_ACCOUNT));
  return client && typeof client.clientId === "string" && typeof client.clientSecret === "string" && client.clientId && client.clientSecret
    ? { clientId: client.clientId, clientSecret: client.clientSecret }
    : null;
}

async function readTokens(store: SecretStore): Promise<GoogleTokens | null> {
  const tokens = parseJson<Partial<GoogleTokens>>(await store.read(TOKENS_ACCOUNT));
  return tokens && typeof tokens.access === "string" && typeof tokens.refresh === "string" ? (tokens as GoogleTokens) : null;
}

export type GoogleDriveDeps = {
  readonly open?: (url: string) => void;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
};

type LoginState = { status: "pending" } | { status: "error"; message: string };

/**
 * Mounts the connection's routes on `app`:
 *
 *  - `GET  /google-drive`            the connection's state
 *  - `POST /google-drive/connect`    `{clientId, clientSecret}`: keeps the client and starts the sign-in; returns `{authorizeUrl}`
 *  - `POST /google-drive/cancel`     stops a sign-in in flight
 *  - `POST /google-drive/disconnect` revokes and forgets the tokens; the client is kept
 *  - `POST /google-drive/slides`     `{name, pptxBase64}`: uploads the PowerPoint as Google Slides; returns `{id, url, name}`
 */
export function mountGoogleDrive<E extends Env>(app: Hono<E>, copy: CallbackPageCopy, store: SecretStore, deps: GoogleDriveDeps = {}): void {
  const open = deps.open ?? openInBrowser;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const LABEL = "Google Drive";
  let login: LoginState | null = null;
  let inFlight: AbortController | null = null;

  const status = async (): Promise<GoogleDriveStatus> => {
    const [client, tokens] = await Promise.all([readClient(store), readTokens(store)]);
    return {
      connected: tokens !== null,
      email: tokens?.email ?? null,
      clientId: client?.clientId ?? null,
      login: login ?? { status: "idle" },
    };
  };

  app.get("/google-drive", async (c) => c.json(await status()));

  app.post("/google-drive/connect", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { clientId?: unknown; clientSecret?: unknown };
    const remembered = await readClient(store);
    const clientId = typeof body.clientId === "string" && body.clientId.trim() ? body.clientId.trim() : remembered?.clientId;
    const clientSecret = typeof body.clientSecret === "string" && body.clientSecret.trim() ? body.clientSecret.trim() : remembered?.clientSecret;
    if (!clientId || !clientSecret) {
      return c.json({ error: { code: "validation_failed", message: "A Google OAuth client id and secret are needed to connect." } }, 400);
    }
    const client: GoogleClient = { clientId, clientSecret };
    await store.write(CLIENT_ACCOUNT, JSON.stringify(client));

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    login = { status: "pending" };
    // The callback binds a free loopback port, so the redirect URI is known
    // only once it is up; the authorize URL and the exchange read it from here.
    let redirectUri = "";
    try {
      const handle = await startOAuthLogin<GoogleTokens>(
        { profile: "google-drive", signal: controller.signal, now },
        {
          startCallbackServer: async (state) => {
            const server = await startCallbackServer(state, {
              host: "127.0.0.1",
              port: 0,
              path: CALLBACK_PATH,
              doneHtml: authorizationDoneHtml(LABEL, copy),
              failedHtml: (reason) => callbackPageHtml({ subject: LABEL, error: reason }, copy),
            });
            redirectUri = `http://127.0.0.1:${String(server.port)}${CALLBACK_PATH}`;
            return server;
          },
          buildAuthorizeUrl: (pkce, state) => buildAuthorizeUrl(googleOAuthConfig(client, redirectUri), pkce, state),
          exchangeCode: (code, verifier, at) => exchangeGoogleCode(client, redirectUri, code, verifier, at, fetchImpl),
          saveProfile: async ({ tokens }) => {
            await store.write(TOKENS_ACCOUNT, JSON.stringify(tokens));
            login = null;
          },
          openInBrowser: open,
        },
      );
      void handle.completed
        .then((staged) => staged.commit())
        .catch((cause) => {
          if (!controller.signal.aborted) login = { status: "error", message: cause instanceof Error ? cause.message : String(cause) };
        });
      return c.json({ authorizeUrl: handle.authorizeUrl });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      login = { status: "error", message };
      return c.json({ error: { code: "oauth_start_failed", message } }, 502);
    }
  });

  app.post("/google-drive/cancel", (c) => {
    inFlight?.abort();
    inFlight = null;
    login = null;
    return c.json({ status: "idle" as const });
  });

  app.post("/google-drive/disconnect", async (c) => {
    inFlight?.abort();
    inFlight = null;
    login = null;
    const tokens = await readTokens(store);
    if (tokens) {
      // Best effort: the grant is Google's to forget; ours goes regardless.
      await fetchImpl(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refresh }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    await store.write(TOKENS_ACCOUNT, "");
    return c.json(await status());
  });

  app.post("/google-drive/slides", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; pptxBase64?: unknown };
    if (typeof body.name !== "string" || !body.name.trim() || typeof body.pptxBase64 !== "string" || !body.pptxBase64) {
      return c.json({ error: { code: "validation_failed", message: "The slides need a name and the PowerPoint's bytes." } }, 400);
    }
    const [client, stored] = await Promise.all([readClient(store), readTokens(store)]);
    if (!client || !stored) {
      return c.json({ error: { code: "not_connected", message: "Google Drive is not connected. Connect it in Settings, then try again." } }, 409);
    }
    const pptx = new Uint8Array(Buffer.from(body.pptxBase64, "base64"));
    let tokens = stored;
    const refresh = async () => {
      try {
        tokens = await refreshGoogleTokens(client, tokens, now(), fetchImpl);
      } catch (cause) {
        // A refresh Google refuses means the grant is gone: the person
        // revoked it, or the client changed. Say so rather than retry forever.
        await store.write(TOKENS_ACCOUNT, "");
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new GoogleUploadError(401, `${reason}. Connect Google Drive again in Settings.`);
      }
      await store.write(TOKENS_ACCOUNT, JSON.stringify(tokens));
    };
    try {
      if (accessTokenStale(tokens, now())) await refresh();
      let uploaded: UploadedSlides;
      try {
        uploaded = await uploadAsGoogleSlides(tokens.access, body.name.trim(), pptx, fetchImpl);
      } catch (cause) {
        if (!(cause instanceof GoogleUploadError) || cause.status !== 401) throw cause;
        await refresh();
        uploaded = await uploadAsGoogleSlides(tokens.access, body.name.trim(), pptx, fetchImpl);
      }
      return c.json(uploaded);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = cause instanceof GoogleUploadError && cause.status === 401 ? 409 : 502;
      return c.json({ error: { code: status === 409 ? "not_connected" : "google_upload_failed", message } }, status);
    }
  });
}
