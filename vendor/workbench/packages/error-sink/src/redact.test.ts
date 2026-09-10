import { describe, expect, test } from "bun:test";
import { redactExtra, redactText } from "./redact";

describe("redactText", () => {
  test("redacts a bearer token", () => {
    expect(redactText("failed calling api with Bearer abc123.def456")).toBe(
      "failed calling api with [redacted]",
    );
  });

  test("redacts an authorization header fragment", () => {
    expect(redactText("Authorization: sk-live-abcdefgh1234")).toBe(
      "[redacted]",
    );
  });

  test("redacts a recognizable key-prefixed secret", () => {
    expect(redactText("using key sk-abcdefgh1234 to call provider")).toBe(
      "using key [redacted] to call provider",
    );
  });

  test("leaves ordinary text untouched", () => {
    expect(redactText("could not reach the hub")).toBe(
      "could not reach the hub",
    );
  });

  test("redacts sensitive query-param values in a URL while keeping it readable", () => {
    expect(
      redactText(
        "callback failed: https://api.example.com/cb?access_token=SECRETVALUE123&code=abc&state=xyz",
      ),
    ).toBe(
      "callback failed: https://api.example.com/cb?access_token=[redacted]&code=[redacted]&state=xyz",
    );
  });

  test("redacts token= style assignments in free text", () => {
    expect(redactText("failed request token=abc123xyz retries=3")).toBe(
      "failed request token=[redacted] retries=3",
    );
  });

  test("redacts a raw JWT with no keyword prefix", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzbm90YXJlYWxzaWc";
    expect(redactText(`session restore failed for ${jwt}`)).toBe(
      "session restore failed for [redacted]",
    );
  });

  test("redacts code=/key= only in query-string position, not free text", () => {
    expect(redactText('code=404 message="Not Found"')).toBe(
      'code=404 message="Not Found"',
    );
    expect(
      redactText('level=error msg="db timeout" code=DB_TIMEOUT retries=3'),
    ).toBe('level=error msg="db timeout" code=DB_TIMEOUT retries=3');
    expect(redactText("cache miss for key=user:1234:profile")).toBe(
      "cache miss for key=user:1234:profile",
    );
    expect(redactText("at /routes/key=handler.ts:12:5)")).toBe(
      "at /routes/key=handler.ts:12:5)",
    );
  });

  test("redacts code=/key= when they appear as a URL query param", () => {
    expect(
      redactText(
        "https://api.example.com/authorize?client_id=abc&code=SECRETCODE",
      ),
    ).toBe("https://api.example.com/authorize?client_id=abc&code=[redacted]");
    expect(
      redactText("https://api.example.com/data?key=APIKEYVALUE&format=json"),
    ).toBe("https://api.example.com/data?key=[redacted]&format=json");
  });

  test("does not let the value group run past a stack-frame's trailing text", () => {
    expect(
      redactText("auth failed token=abc123).authenticate() at line 4"),
    ).toBe("auth failed token=[redacted]).authenticate() at line 4");
  });
});

describe("redactExtra", () => {
  test("redacts a value whose key looks like a credential", () => {
    expect(
      redactExtra({ apiKey: "sk-abcdefgh1234", userId: "user_1" }),
    ).toEqual({ apiKey: "[redacted]", userId: "user_1" });
  });

  test("redacts nested objects by key", () => {
    expect(
      redactExtra({
        headers: { authorization: "Bearer abc.def", accept: "json" },
        repoIds: ["repo_1", "repo_2"],
      }),
    ).toEqual({
      headers: { authorization: "[redacted]", accept: "json" },
      repoIds: ["repo_1", "repo_2"],
    });
  });

  test("redacts an entire field whose key name itself looks secret-shaped", () => {
    // A field literally named "tokens" is redacted wholesale rather than
    // recursed into -- better to over-redact a suspicious key than miss a
    // real one nested inside it.
    expect(redactExtra({ tokens: ["tok_1", "tok_2"] })).toEqual({
      tokens: "[redacted]",
    });
  });

  test("scans plain string values for secret patterns even under a safe key", () => {
    expect(redactExtra({ detail: "rejected Bearer abc123" })).toEqual({
      detail: "rejected [redacted]",
    });
  });

  test("passes undefined through unchanged", () => {
    expect(redactExtra(undefined)).toBeUndefined();
  });

  test("redacts a raw secret string inside an array under a non-secret key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzbm90YXJlYWxzaWc";
    expect(redactExtra({ sessions: [jwt, "plain-session-id"] })).toEqual({
      sessions: ["[redacted]", "plain-session-id"],
    });
  });
});
