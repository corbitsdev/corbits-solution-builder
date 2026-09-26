import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { assertSelfAuthenticatingPrefix, isSelfAuthenticatingPath, sessionDoor } from "./door.ts";

const EXEMPT = ["/api/workflow-artifacts"];
const TOKEN = "host-token";

function hostApp(prefixes: readonly string[] = EXEMPT) {
  const app = new Hono();
  app.use(
    "/api/*",
    sessionDoor({
      authorised: (context) => context.req.header("authorization") === `Bearer ${TOKEN}`,
      selfAuthenticatingPaths: prefixes,
      unauthorised: { error: { code: "unauthenticated" } },
    }),
  );
  // Stands in for the hub's mounted routes: the mount answers with what it
  // saw, so a test can tell the door let the request through untouched.
  app.all("/api/*", (context) => context.json({ path: new URL(context.req.url).pathname, bearer: context.req.header("authorization") ?? null }));
  return app;
}

async function status(app: Hono, path: string, headers: Record<string, string> = {}, method = "POST"): Promise<number> {
  const response = await app.request(`http://127.0.0.1${path}`, { method, headers });
  return response.status;
}

describe("sessionDoor", () => {
  test("an exempt prefix bypasses the door, and its own bearer reaches the mount untouched", async () => {
    const app = hostApp();
    const response = await app.request("http://127.0.0.1/api/workflow-artifacts/artifacts", {
      method: "POST",
      headers: { authorization: "Bearer run-scoped", "x-workflow-run-address": "run_1@workspace.localhost" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/api/workflow-artifacts/artifacts", bearer: "Bearer run-scoped" });
    expect(await status(app, "/api/workflow-artifacts/artifacts/binary")).toBe(200);
    expect(await status(app, "/api/workflow-artifacts")).toBe(200);
  });

  test("a non-exempt path still needs the host credential", async () => {
    const app = hostApp();
    expect(await status(app, "/api/tenants", {}, "GET")).toBe(401);
    expect(await status(app, "/api/tenants", { authorization: "Bearer run-scoped" }, "GET")).toBe(401);
    expect(await status(app, "/api/tenants", { authorization: `Bearer ${TOKEN}` }, "GET")).toBe(200);
    expect(await status(app, "/api/status", {}, "GET")).toBe(401);
  });

  test("a prefix match cannot be widened", async () => {
    const app = hostApp();
    expect(await status(app, "/api/workflow-artifacts-evil/artifacts")).toBe(401);
    expect(await status(app, "/api/workflow-artifactsX")).toBe(401);
    expect(await status(app, "/api/workflow-artifacts/../tenants")).toBe(401);
    expect(await status(app, "/api/workflow-artifacts/%2e%2e/tenants")).toBe(401);
    expect(await status(app, "/api/workflow-artifacts%2Fartifacts")).toBe(401);
    expect(await status(app, "/api/tenants?path=/api/workflow-artifacts", {}, "GET")).toBe(401);
  });

  test("with nothing declared, every /api path is behind the door", async () => {
    const app = hostApp([]);
    expect(await status(app, "/api/workflow-artifacts/artifacts")).toBe(401);
  });
});

describe("isSelfAuthenticatingPath", () => {
  test("judges the normalised pathname against each prefix", () => {
    expect(isSelfAuthenticatingPath("http://h/api/workflow-artifacts/artifacts", EXEMPT)).toBe(true);
    expect(isSelfAuthenticatingPath("http://h/api/workflow-artifacts", EXEMPT)).toBe(true);
    expect(isSelfAuthenticatingPath("http://h/api/workflow-artifacts/", EXEMPT)).toBe(true);
    expect(isSelfAuthenticatingPath("http://h/api/workflow-artifacts/../tenants", EXEMPT)).toBe(false);
    expect(isSelfAuthenticatingPath("http://h/api/workflow-artifacts-evil", EXEMPT)).toBe(false);
    expect(isSelfAuthenticatingPath("http://h/api/tenants", EXEMPT)).toBe(false);
  });
});

describe("assertSelfAuthenticatingPrefix", () => {
  test("refuses a prefix that could never match, or would match too much", () => {
    expect(() => assertSelfAuthenticatingPrefix("/api/workflow-artifacts")).not.toThrow();
    expect(() => assertSelfAuthenticatingPrefix("api/workflow-artifacts")).toThrow();
    expect(() => assertSelfAuthenticatingPrefix("/api/workflow-artifacts/")).toThrow();
    expect(() => assertSelfAuthenticatingPrefix("/api/x/../workflow-artifacts")).toThrow();
    expect(() => assertSelfAuthenticatingPrefix("/api/workflow-artifacts?x")).toThrow();
  });
});
