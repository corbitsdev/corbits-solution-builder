import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountProviderOAuth } from "./oauth-mount.js";

describe("mountProviderOAuth", () => {
  test("responds on the login-start route for a known provider", async () => {
    const app = new Hono();
    mountProviderOAuth(app, () => undefined);

    const response = await app.request("/oauth/codex-oauth/start", { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl: string };
    expect(body.authorizeUrl).toContain("auth.openai.com");
  });

  test("404s a login-start route for a provider it does not carry", async () => {
    const app = new Hono();
    mountProviderOAuth(app, () => undefined);

    const response = await app.request("/oauth/not-a-provider/start", { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("status is idle before any login has started", async () => {
    const app = new Hono();
    mountProviderOAuth(app, () => undefined);

    const response = await app.request("/oauth/xai-oauth/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "idle" });
  });
});
