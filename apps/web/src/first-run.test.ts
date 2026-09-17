import { describe, expect, test } from "bun:test";
import { firstRunScreen } from "./first-run.ts";

describe("firstRunScreen", () => {
  test("boots until the host has answered and the hub session is known", () => {
    expect(firstRunScreen({ status: null, auth: "unknown", installed: "checking" })).toBe("boot");
    expect(firstRunScreen({ status: { ok: true }, auth: "unknown", installed: "checking" })).toBe("boot");
    expect(firstRunScreen({ status: null, auth: "signed-out", installed: "checking" })).toBe("boot");
  });

  test("asks for signup or login before install", () => {
    expect(firstRunScreen({ status: { ok: true }, auth: "signed-out", installed: "checking" })).toBe("auth");
    expect(firstRunScreen({ status: { ok: true }, auth: "signed-out", installed: "ready" })).toBe("auth");
  });

  test("installs as the signed-in session, not before", () => {
    expect(firstRunScreen({ status: { ok: true }, auth: "signed-in", installed: "checking" })).toBe("install");
    expect(firstRunScreen({ status: { ok: true }, auth: "signed-in", installed: "installing" })).toBe("install");
  });

  test("opens the app only after a hub session and a finished install", () => {
    expect(firstRunScreen({ status: { ok: true }, auth: "signed-in", installed: "ready" })).toBe("ready");
  });
});
