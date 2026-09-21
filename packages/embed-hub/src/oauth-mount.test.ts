import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountProviderOAuth } from "./oauth-mount.js";
import { PAGE_COPY } from "./oauth-mount.js";
import { authorizationDoneHtml, callbackPageHtml } from "./oauth-page.js";

describe("mountProviderOAuth", () => {
  test("responds on the login-start route for a known provider", async () => {
    const app = new Hono();
    mountProviderOAuth(app, () => undefined);

    const response = await app.request("/api/oauth/codex-oauth/start", { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl: string };
    expect(body.authorizeUrl).toContain("auth.openai.com");
  });

  test("404s a login-start route for a provider it does not carry", async () => {
    const app = new Hono();
    mountProviderOAuth(app, () => undefined);

    const response = await app.request("/api/oauth/not-a-provider/start", { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("status is idle before any login has started", async () => {
    const app = new Hono();
    mountProviderOAuth(app, () => undefined);

    const response = await app.request("/api/oauth/xai-oauth/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "idle" });
  });
});

describe("oauth callback page", () => {
  test("a hostile reason is escaped on the failure page", async () => {
    const html = callbackPageHtml(
      { subject: "xAI (Grok)", error: "<script>alert(1)</script>" },
      PAGE_COPY,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the failure heading names the provider", async () => {
    const html = callbackPageHtml({ subject: "xAI (Grok)", error: "access_denied" }, PAGE_COPY);
    expect(html).toContain("xAI (Grok) failed to connect");
  });

  test("the done page reports authorization received, not a completed connection", async () => {
    const html = authorizationDoneHtml("ChatGPT (Codex)", PAGE_COPY);
    expect(html).toContain("ChatGPT (Codex) authorization received");
    expect(html).not.toContain("connected successfully");
  });
});
