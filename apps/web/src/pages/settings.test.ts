import { describe, expect, test } from "bun:test";
import { hostCredentialsCopy, hostStatusCopy, roleLabel } from "./settings.tsx";
import type { HostStatus } from "../client.ts";

function fixtureStatus(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    apiVersion: "1",
    host: {
      state: "ready",
      startedAt: "2026-09-08T12:00:00.000Z",
      pid: 12,
      connectedClients: 1,
      sleepGaps: [],
      windowlessWorkContinues: true,
    },
    credentialBackend: "keychain",
    canPlaceSidecars: false,
    sidecarFingerprint: null,
    hub: { mode: "embedded", url: null, ready: true, detail: "" },
    ...overrides,
  };
}

describe("settings page copy", () => {
  test("role labels drop underscores", () => {
    expect(roleLabel("budget_approver")).toBe("budget approver");
  });

  test("host status matches the mockup running · embedded hub line", () => {
    expect(hostStatusCopy(fixtureStatus())).toBe("Running · embedded hub");
  });

  test("host credentials name the keychain when that is the backend", () => {
    expect(hostCredentialsCopy(fixtureStatus())).toBe("macOS Keychain");
    expect(hostCredentialsCopy(fixtureStatus({ credentialBackend: "file" }))).toBe("private file on disk");
  });
});

describe("settings page markup language", () => {
  test("the page uses the mockup's section / row / k / v / seg-ctl classes", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    const css = await Bun.file(new URL("./settings-layout.css", import.meta.url)).text();
    expect(page).toContain('className="settings-page"');
    expect(page).toContain('className="section-body"');
    expect(page).toContain('className="seg-ctl"');
    expect(page).toContain('className="k"');
    expect(css).toContain("max-width: 720px");
    expect(css).toContain(".settings-page .section-body");
    expect(css).toContain(".settings-page .row .k");
    expect(css).toContain(".settings-page .seg-ctl");
  });

  test("mockup sections stay, and existing extra settings stay in the same language", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    for (const title of [
      "Appearance",
      "Inference",
      "Designer",
      "Stakeholder decks",
      "This computer",
      "Start when you log in",
      "If a design exceeds the limit",
      "Stakeholder deck templates",
      "Diagnostics",
    ]) {
      expect(page).toContain(title);
    }
  });
});
