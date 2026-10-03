import { describe, expect, test } from "bun:test";
import { googleDriveCopy, languageOptionLabel, hostConnectionCopy, hostCredentialsCopy, hostDataCopy, roleLabel, deckThemeLabel, DECK_THEME_CHOICES } from "./settings.tsx";
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
    sidecarsLostBefore: null,
    hub: { mode: "embedded", url: null, ready: true, detail: "" },
    ...overrides,
  };
}

describe("settings page copy", () => {
  test("role labels drop underscores and capitalize", () => {
    expect(roleLabel("budget_approver")).toBe("Budget approver");
  });

  test("deck Edit themes are the mockup's Minimal / Detailed / Bold", () => {
    expect(DECK_THEME_CHOICES.map((choice) => choice.label)).toEqual(["Minimal", "Detailed", "Bold"]);
    expect(deckThemeLabel("slate")).toBe("Minimal");
    expect(deckThemeLabel("navy")).toBe("Detailed");
    expect(deckThemeLabel("ember")).toBe("Bold");
    expect(deckThemeLabel("forest")).toBe("Detailed");
    expect(deckThemeLabel("plum")).toBe("Bold");
  });

  test("host connection names local vs. remote Interchange from hub mode", () => {
    expect(hostConnectionCopy(fixtureStatus())).toBe("Local Interchange Connection");
    expect(hostConnectionCopy(fixtureStatus({ hub: { mode: "remote", url: "https://hub.example", ready: true, detail: "" } }))).toBe(
      "Remote Interchange Connection",
    );
  });

  test("host credentials name the keychain when that is the backend, and Interchange storage for a remote hub", () => {
    expect(hostCredentialsCopy(fixtureStatus())).toBe("macOS Keychain");
    expect(hostCredentialsCopy(fixtureStatus({ credentialBackend: "file" }))).toBe("private file on disk");
    expect(
      hostCredentialsCopy(fixtureStatus({ credentialBackend: "file", hub: { mode: "remote", url: "https://hub.example", ready: true, detail: "" } })),
    ).toBe("Interchange Credential Storage");
  });

  test("the Data row is the host-reported workspace directory, not a guessed Library folder", () => {
    expect(hostDataCopy(fixtureStatus({ dataDir: "/tmp/workspace-data" }))).toBe("/tmp/workspace-data");
    expect(hostDataCopy(fixtureStatus())).toBeNull();
  });
});

// #233: the Google Drive row says who is connected, or what connecting takes.
describe("googleDriveCopy", () => {
  const idle = { status: "idle" as const };
  test("names the account when connected, and the remembered client when not", () => {
    expect(googleDriveCopy(null)).toBe("Checking…");
    expect(googleDriveCopy({ connected: true, email: "brian@example.com", clientId: "c", login: idle })).toBe("Connected as brian@example.com.");
    expect(googleDriveCopy({ connected: true, email: null, clientId: "c", login: idle })).toBe("Connected.");
    expect(googleDriveCopy({ connected: false, email: null, clientId: null, login: idle })).toBe("Not connected.");
    expect(googleDriveCopy({ connected: false, email: null, clientId: "c", login: idle })).toContain("remembered");
    expect(googleDriveCopy({ connected: false, email: null, clientId: "c", login: { status: "pending" } })).toContain("Finish signing in");
  });
});

// #411: the five languages are listed; only the two Englishes can be chosen as output.
describe("languageOptionLabel", () => {
  test("marks an output language that is not supported yet, and leaves inputs alone", () => {
    expect(languageOptionLabel("en-GB", "British English", true)).toBe("British English");
    expect(languageOptionLabel("fr", "French", true)).toBe("French (not supported yet)");
    expect(languageOptionLabel("fr", "French", false)).toBe("French");
  });
});
