import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@intx/hub-client";
import { getHubSession, signInHub, signUpHub } from "./hub-auth.ts";

describe("hub email auth", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test("reads the session from /api/auth/get-session with same-origin credentials", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return new Response(JSON.stringify({ user: { id: "u1", email: "you@example.com", name: "You" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const session = await getHubSession();
    expect(session?.user).toEqual({ id: "u1", email: "you@example.com", name: "You" });
    expect(calls[0]?.url).toBe("/api/auth/get-session");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
  });

  test("treats 401 as signed out", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect(await getHubSession()).toBeNull();
  });

  test("signs up against /api/auth/sign-up/email", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return new Response(JSON.stringify({ user: { id: "u1", email: "you@example.com", name: "You" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const user = await signUpHub({ email: "you@example.com", password: "password1", name: "You" });
    expect(user.email).toBe("you@example.com");
    expect(calls[0]?.url).toBe("/api/auth/sign-up/email");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
  });

  test("signs in against /api/auth/sign-in/email", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("/api/auth/sign-in/email");
      expect(init?.credentials).toBe("same-origin");
      return new Response(JSON.stringify({ user: { id: "u1", email: "you@example.com" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const user = await signInHub({ email: "you@example.com", password: "password1" });
    expect(user).toEqual({ id: "u1", email: "you@example.com", name: "you@example.com" });
  });

  test("surfaces a hub auth error as ApiError", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Invalid email or password" }), {
        status: 401,
      })) as unknown as typeof fetch;

    try {
      await signInHub({ email: "you@example.com", password: "no" });
      throw new Error("expected ApiError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ApiError);
      expect((cause as ApiError).status).toBe(401);
      expect((cause as ApiError).message).toBe("Invalid email or password");
    }
  });
});
