import { describe, expect, test } from "bun:test";
import { hostCredentialsCopy, hostDataCopy, hostStatusCopy, roleLabel, deckThemeLabel, DECK_THEME_CHOICES } from "./settings.tsx";
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

  test("deck Edit themes are the mockup's Minimal / Detailed / Bold", () => {
    expect(DECK_THEME_CHOICES.map((choice) => choice.label)).toEqual(["Minimal", "Detailed", "Bold"]);
    expect(deckThemeLabel("slate")).toBe("Minimal");
    expect(deckThemeLabel("navy")).toBe("Detailed");
    expect(deckThemeLabel("ember")).toBe("Bold");
    expect(deckThemeLabel("forest")).toBe("Detailed");
    expect(deckThemeLabel("plum")).toBe("Bold");
  });

  test("host status matches the mockup running · embedded hub line", () => {
    expect(hostStatusCopy(fixtureStatus())).toBe("Running · embedded hub");
  });

  test("host credentials name the keychain when that is the backend", () => {
    expect(hostCredentialsCopy(fixtureStatus())).toBe("macOS Keychain");
    expect(hostCredentialsCopy(fixtureStatus({ credentialBackend: "file" }))).toBe("private file on disk");
  });

  test("the Data row is the host-reported workspace directory, not a guessed Library folder", () => {
    expect(hostDataCopy(fixtureStatus({ dataDir: "/tmp/workspace-data" }))).toBe("/tmp/workspace-data");
    expect(hostDataCopy(fixtureStatus())).toBeNull();
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
    expect(css).toContain(".settings-page .btn");
    expect(css).toContain(".settings-page .refresh-models");
  });

  test("mockup sections stay, and the extras the mockup cut are gone", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    for (const title of ["Appearance", "Inference", "Designer", "Stakeholder decks", "This computer"]) {
      expect(page).toContain(title);
    }
    expect(page).toContain("ProviderList");
    expect(page).not.toContain("ResolvedCatalogList");
    expect(page).not.toContain("DeckTemplates");
    expect(page).not.toContain("Diagnostics");
    expect(page).not.toContain("Start when you log in");
    expect(page).not.toContain("Stop the host");
    expect(page).not.toContain("If a design exceeds the limit");
    expect(page).not.toContain("onLimit");
    expect(page).not.toContain("Stakeholder deck templates");
    expect(page).not.toContain("document token budget");
    expect(page).not.toContain("Make default");
    expect(page).not.toContain("Move up");
    expect(page).not.toContain("Restrict");
    expect(page).not.toContain("Shadow");
  });

  test("Designer output-limit copy is the mockup's, not token-budget jargon", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    expect(page).toContain('label="Output limit"');
    expect(page).toContain("Tokens per design — most need 20,000–40,000; a design that uses them all is cut short");
    expect(page).not.toContain("If a design exceeds the limit");
  });

  test("This computer shows Data from host status between Credentials and Version", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    const client = await Bun.file(new URL("../client.ts", import.meta.url)).text();
    const host = await Bun.file(new URL("../../../hub/src/api-host.ts", import.meta.url)).text();
    const credentials = page.indexOf('label="Credentials"');
    const data = page.indexOf('label="Data"');
    const version = page.indexOf('label="Version"');
    expect(credentials).toBeGreaterThan(-1);
    expect(data).toBeGreaterThan(credentials);
    expect(version).toBeGreaterThan(data);
    expect(page).toContain("{hostDataCopy(status)}");
    expect(page).not.toContain("~/Library");
    expect(page).not.toContain("Application Support");
    expect(client).toMatch(/dataDir\?: string/);
    expect(host).toContain("dataDir: dataDirectory()");
    expect(page).not.toContain("Start when you log in");
    expect(page).not.toContain("Stop the host");
    expect(page).not.toContain("quit_app");
    expect(page).not.toContain("set_start_at_login");
  });

  test("inference is one section-body of provider rows, with no catalog card", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    const inference = page.slice(page.indexOf("function Inference"), page.indexOf("/* ----------------------------------------------------------------- designer"));
    expect(inference.match(/className="section-body"/g)?.length).toBe(1);
    expect(inference).toContain("ProviderList");
    expect(inference).not.toContain("ResolvedCatalogList");
  });

  test("stakeholder Edit opens Theme seg-ctl only", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    const decks = page.slice(page.indexOf("function StakeholderDecks"), page.indexOf("/* ------------------------------------------------------------ this computer"));
    expect(decks).toContain('label="Theme"');
    expect(decks).toContain("<SegCtl");
    expect(decks).toContain("DECK_THEME_CHOICES");
    expect(decks).toContain("STAKEHOLDER_ROLES");
    expect(decks).not.toContain("Executive");
    expect(decks).not.toContain("Typeface");
    expect(decks).not.toContain("Density");
    expect(decks).not.toContain("Speaker notes");
    expect(decks).not.toContain("What the outline should emphasise");
    expect(decks).not.toContain("label=\"Images\"");
    expect(decks).not.toContain("DECK_THEMES");
    expect(decks).not.toContain("DeckTemplates");
  });

  test("settings chrome is outline .btn / .btn.link, not the library Button", async () => {
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    const providers = await Bun.file(new URL("./providers.tsx", import.meta.url)).text();
    const css = await Bun.file(new URL("./settings-layout.css", import.meta.url)).text();
    expect(page).not.toMatch(/import \{[^}]*Button[^}]*\} from "\.\.\/components/);
    expect(page).toContain('className="btn link"');
    expect(providers).toContain('kind === "link" ? "btn link" : "btn"');
    expect(css).toContain(".settings-page .btn");
    expect(css).toContain(".settings-page .btn.link");
  });
});

describe("provider and catalog row language", () => {
  test("connections flatten to row / k / v with outline Connect and muted Connected", async () => {
    const source = await Bun.file(new URL("./providers.tsx", import.meta.url)).text();
    expect(source).toContain('className="row"');
    expect(source).toContain('className="k"');
    expect(source).toContain('className="v"');
    expect(source).toContain('kind === "refresh" ? "refresh-models"');
    expect(source).toContain('kind === "link" ? "btn link" : "btn"');
    expect(source).toContain("Connected");
    expect(source).toContain("Refresh models");
    expect(source).toContain("refreshProviderModels");
    expect(source).toContain("{connected ? \"Reconnect\" : \"Connect\"}");
    expect(source).not.toContain("Disconnect");
    expect(source).not.toContain("StateLabel");
    expect(source).not.toContain("variant=\"primary\"");
    expect(source).not.toContain("provider-row");
  });

  test("catalog keeps its actions as row .v links off this page", async () => {
    const source = await Bun.file(new URL("./providers.tsx", import.meta.url)).text();
    const page = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
    for (const action of ["Make default", "Move up", "Move down", "Restrict", "Shadow", "Manage connection"]) {
      expect(source).toContain(action);
      expect(page).not.toContain(action);
    }
    expect(source).not.toContain("<ul className=\"provider-list\"");
  });
});
