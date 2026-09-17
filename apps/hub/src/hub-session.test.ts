import { describe, expect, test } from "bun:test";
import {
  currentSession,
  rememberSession,
  sessionPairFromCookieHeader,
  sessionPairFromSetCookie,
  sessionPairFromSetCookieHeaders,
} from "./hub-session.js";

describe("hub session cookie", () => {
  test("takes the Better Auth pair from Set-Cookie", () => {
    expect(sessionPairFromSetCookie("better-auth.session_token=abc.def; Path=/; HttpOnly")).toBe(
      "better-auth.session_token=abc.def",
    );
  });

  test("reads the Better Auth pair from an inbound Cookie header", () => {
    expect(
      sessionPairFromCookieHeader(
        "solutions_builder_session=host; better-auth.session_token=abc.def",
      ),
    ).toBe("better-auth.session_token=abc.def");
  });

  test("prefers the session token among multiple Set-Cookie headers", () => {
    const headers = new Headers();
    headers.append("set-cookie", "other=1; Path=/");
    headers.append("set-cookie", "better-auth.session_token=abc.def; Path=/; HttpOnly");
    expect(sessionPairFromSetCookieHeaders(headers)).toBe("better-auth.session_token=abc.def");
  });

  test("remembers the pair for in-process hub calls", () => {
    rememberSession(null);
    expect(currentSession()).toBeNull();
    rememberSession("better-auth.session_token=abc.def");
    expect(currentSession()).toBe("better-auth.session_token=abc.def");
    rememberSession(null);
  });
});
