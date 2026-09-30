import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  CLIENT_ACCOUNT,
  GOOGLE_SLIDES_MIME,
  GOOGLE_TOKEN_URL,
  GOOGLE_UPLOAD_URL,
  PPTX_MIME,
  TOKENS_ACCOUNT,
  accessTokenStale,
  emailFromIdToken,
  googleOAuthConfig,
  googleTokensFromResponse,
  mountGoogleDrive,
  slidesUploadBody,
  type GoogleTokens,
  type SecretStore,
} from "./google-drive.js";
import type { CallbackPageCopy } from "./oauth-page.js";

const COPY: CallbackPageCopy = {
  productName: "Test Product",
  siteUrl: "https://example.com",
  siteLabel: "example.com",
  githubUrl: "https://github.com/example/product",
  githubLabel: "github.com/example/product",
};
const CLIENT = { clientId: "id-1.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" };

function memoryStore(initial: Record<string, string> = {}): SecretStore & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async read(account) {
      const value = values.get(account);
      return value ? value : null;
    },
    async write(account, value) {
      values.set(account, value);
    },
  };
}

/** A fake `fetch` for the module: the real type also carries `preconnect`, which nothing here calls. */
const asFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => fn as unknown as typeof fetch;

function idToken(claims: Record<string, unknown>): string {
  const b64 = (raw: string) => Buffer.from(raw).toString("base64url");
  return `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify(claims))}.sig`;
}

describe("the Google OAuth client", () => {
  test("asks for offline access with consent, the Drive file scope and the loopback redirect", () => {
    const config = googleOAuthConfig(CLIENT, "http://127.0.0.1:51234/google-drive/callback");
    expect(config.clientId).toBe(CLIENT.clientId);
    expect(config.scopes).toContain("https://www.googleapis.com/auth/drive.file");
    expect(config.scopes).not.toContain("https://www.googleapis.com/auth/drive");
    expect(config.extraAuthorizeParams).toEqual({ access_type: "offline", prompt: "consent" });
    expect(config.redirectUri).toBe("http://127.0.0.1:51234/google-drive/callback");
  });

  test("reads the account's email off the id token and carries the refresh token forward on a refresh", () => {
    expect(emailFromIdToken(idToken({ email: "brian@example.com" }))).toBe("brian@example.com");
    expect(emailFromIdToken("not-a-jwt")).toBeUndefined();
    const first = googleTokensFromResponse(
      { access_token: "a1", refresh_token: "r1", expires_in: 3600, id_token: idToken({ email: "brian@example.com" }) },
      1_000,
    );
    expect(first).toEqual({ access: "a1", refresh: "r1", expiresAt: 3_601_000, email: "brian@example.com" });
    const refreshed = googleTokensFromResponse({ access_token: "a2", expires_in: 3600 }, 2_000, first);
    expect(refreshed).toEqual({ access: "a2", refresh: "r1", expiresAt: 3_602_000, email: "brian@example.com" });
    expect(() => googleTokensFromResponse({ access_token: "a3" }, 0)).toThrow(/no refresh token/);
  });

  test("an access token is stale when expired, within a minute of it, or of unknown life", () => {
    expect(accessTokenStale({ access: "a", refresh: "r", expiresAt: 100_000 }, 10_000)).toBe(false);
    expect(accessTokenStale({ access: "a", refresh: "r", expiresAt: 100_000 }, 50_000)).toBe(true);
    expect(accessTokenStale({ access: "a", refresh: "r", expiresAt: 100_000 }, 200_000)).toBe(true);
    expect(accessTokenStale({ access: "a", refresh: "r" }, 0)).toBe(true);
  });
});

describe("slidesUploadBody", () => {
  test("is a multipart/related body whose metadata names Google Slides as the type and whose second part is the PowerPoint", () => {
    const pptx = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    const body = slidesUploadBody("Inteva Complete — Mr Finance", pptx, "b1");
    const text = new TextDecoder().decode(body);
    expect(text).toStartWith("--b1\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n");
    expect(text).toContain(JSON.stringify({ name: "Inteva Complete — Mr Finance", mimeType: GOOGLE_SLIDES_MIME }));
    expect(text).toContain(`\r\n--b1\r\ncontent-type: ${PPTX_MIME}\r\n\r\nPK\u0003\u0004\r\n--b1--`);
  });
});

describe("mountGoogleDrive", () => {
  const app = (store: SecretStore, fetchImpl: typeof fetch, now = () => 1_000_000) => {
    const hono = new Hono();
    mountGoogleDrive(hono, COPY, store, { open: () => undefined, fetch: fetchImpl, now });
    return hono;
  };
  const noFetch = asFetch(() => Promise.reject(new Error("no network in this test")));

  test("reports not connected with nothing stored, and refuses a connect without a client", async () => {
    const hono = app(memoryStore(), noFetch);
    const status = await hono.request("/google-drive");
    expect(await status.json()).toEqual({ connected: false, email: null, clientId: null, login: { status: "idle" } });
    const connect = await hono.request("/google-drive/connect", { method: "POST", body: JSON.stringify({ clientId: "" }), headers: { "content-type": "application/json" } });
    expect(connect.status).toBe(400);
  });

  test("starting a sign-in keeps the client and returns Google's consent URL with a loopback redirect", async () => {
    const store = memoryStore();
    const hono = app(store, noFetch);
    const response = await hono.request("/google-drive/connect", { method: "POST", body: JSON.stringify(CLIENT), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(200);
    const { authorizeUrl } = (await response.json()) as { authorizeUrl: string };
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT.clientId);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/google-drive\/callback$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(JSON.parse(store.values.get(CLIENT_ACCOUNT) ?? "{}")).toEqual(CLIENT);
    const status = (await (await hono.request("/google-drive")).json()) as { login: { status: string }; clientId: string };
    expect(status.login.status).toBe("pending");
    expect(status.clientId).toBe(CLIENT.clientId);
    await hono.request("/google-drive/cancel", { method: "POST" });
    expect(((await (await hono.request("/google-drive")).json()) as { login: { status: string } }).login.status).toBe("idle");
  });

  test("uploading while not connected is a 409 that says where to connect", async () => {
    const hono = app(memoryStore({ [CLIENT_ACCOUNT]: JSON.stringify(CLIENT) }), noFetch);
    const response = await hono.request("/google-drive/slides", {
      method: "POST",
      body: JSON.stringify({ name: "Deck", pptxBase64: Buffer.from("PK").toString("base64") }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "not_connected" });
  });

  test("uploads the PowerPoint with conversion and returns the document's link, refreshing a stale token first with the client secret", async () => {
    const tokens: GoogleTokens = { access: "old", refresh: "r1", expiresAt: 500, email: "brian@example.com" };
    const store = memoryStore({ [CLIENT_ACCOUNT]: JSON.stringify(CLIENT), [TOKENS_ACCOUNT]: JSON.stringify(tokens) });
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = asFetch(async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url === GOOGLE_TOKEN_URL) {
        return Response.json({ access_token: "fresh", expires_in: 3600 });
      }
      if (url.startsWith(GOOGLE_UPLOAD_URL)) {
        return Response.json({ id: "doc-1", name: "Deck", webViewLink: "https://docs.google.com/presentation/d/doc-1/edit?usp=drivesdk" });
      }
      throw new Error(`unexpected ${url}`);
    });
    const hono = app(store, fetchImpl, () => 1_000_000);
    const response = await hono.request("/google-drive/slides", {
      method: "POST",
      body: JSON.stringify({ name: "Deck", pptxBase64: Buffer.from("PK\u0003\u0004").toString("base64") }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "doc-1", name: "Deck", url: "https://docs.google.com/presentation/d/doc-1/edit?usp=drivesdk" });

    expect(calls.map((call) => call.url.split("?")[0])).toEqual([GOOGLE_TOKEN_URL, GOOGLE_UPLOAD_URL]);
    const refresh = new URLSearchParams(String(calls[0]!.init.body));
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("r1");
    expect(refresh.get("client_secret")).toBe(CLIENT.clientSecret);
    const upload = calls[1]!;
    expect(upload.url).toContain("uploadType=multipart");
    expect(new Headers(upload.init.headers).get("authorization")).toBe("Bearer fresh");
    expect(new Headers(upload.init.headers).get("content-type")).toMatch(/^multipart\/related; boundary=/);
    const sent = await new Response(upload.init.body as Blob).text();
    expect(sent).toContain(`"mimeType":"${GOOGLE_SLIDES_MIME}"`);
    expect(sent).toContain(PPTX_MIME);
    const kept = JSON.parse(store.values.get(TOKENS_ACCOUNT) ?? "{}") as GoogleTokens;
    expect(kept.access).toBe("fresh");
    expect(kept.refresh).toBe("r1");
    expect(kept.email).toBe("brian@example.com");
  });

  test("a refresh Google refuses forgets the tokens and answers not connected", async () => {
    const store = memoryStore({
      [CLIENT_ACCOUNT]: JSON.stringify(CLIENT),
      [TOKENS_ACCOUNT]: JSON.stringify({ access: "old", refresh: "gone", expiresAt: 0 }),
    });
    const fetchImpl = asFetch(async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
    const hono = app(store, fetchImpl);
    const response = await hono.request("/google-drive/slides", {
      method: "POST",
      body: JSON.stringify({ name: "Deck", pptxBase64: "UEs=" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("not_connected");
    expect(error.message).toContain("Token has been expired or revoked");
    expect(error.message).toContain("Connect Google Drive again in Settings");
    expect(store.values.get(TOKENS_ACCOUNT)).toBe("");
    expect(((await (await hono.request("/google-drive")).json()) as { connected: boolean }).connected).toBe(false);
  });

  test("disconnecting revokes the grant and forgets the tokens but keeps the client for next time", async () => {
    const store = memoryStore({
      [CLIENT_ACCOUNT]: JSON.stringify(CLIENT),
      [TOKENS_ACCOUNT]: JSON.stringify({ access: "a", refresh: "r1", expiresAt: 9e12, email: "brian@example.com" }),
    });
    const revoked: string[] = [];
    const fetchImpl = asFetch(async (input, init) => {
      revoked.push(`${String(input)} ${String(init?.body)}`);
      return new Response("", { status: 200 });
    });
    const hono = app(store, fetchImpl);
    const response = await hono.request("/google-drive/disconnect", { method: "POST" });
    expect(await response.json()).toEqual({ connected: false, email: null, clientId: CLIENT.clientId, login: { status: "idle" } });
    expect(revoked).toEqual(["https://oauth2.googleapis.com/revoke token=r1"]);
  });
});
