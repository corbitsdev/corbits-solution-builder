import { describe, expect, test } from "bun:test";
import { initialsOf, passwordProblem } from "./account.ts";

describe("initialsOf", () => {
  test("two initials from a name, one from a single word, the email's first letter when the name is the email", () => {
    expect(initialsOf({ name: "Brian J. Fox", email: "b@x.test" })).toBe("BF");
    expect(initialsOf({ name: "Brian", email: "b@x.test" })).toBe("B");
    expect(initialsOf({ name: "owner@sb.local", email: "owner@sb.local" })).toBe("O");
  });
});

describe("passwordProblem", () => {
  test("too short or mismatched is said; otherwise nothing", () => {
    expect(passwordProblem("short", "short")).toBe("Use at least 8 characters.");
    expect(passwordProblem("longenough", "different")).toBe("The two entries do not match.");
    expect(passwordProblem("longenough", "longenough")).toBeNull();
  });
});
