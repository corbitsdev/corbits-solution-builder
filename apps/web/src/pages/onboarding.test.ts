import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  groupedOnboardingRows,
  markForProvider,
  needsModelChoice,
  Onboarding,
  onboardingRows,
} from "./onboarding.jsx";

const oauth = [{ providerId: "codex-oauth", label: "ChatGPT (Codex)", redirectUri: "x" }];
const keys = [
  { providerId: "anthropic", label: "Anthropic", needsBaseUrl: false },
  { providerId: "compatible", label: "OpenAI-compatible endpoint", needsBaseUrl: true },
];

describe("onboardingRows", () => {
  test("groups the live catalog the way the mockup groups it", () => {
    const rows = onboardingRows(keys, oauth);
    const groups = groupedOnboardingRows(rows);
    expect(groups.map((group) => group.label)).toEqual(["SIGN IN", "API KEY", "ON THIS MACHINE", "CUSTOM"]);
    expect(groups.find((group) => group.group === "signin")?.rows.map((row) => row.action)).toEqual(["Sign in"]);
    expect(groups.find((group) => group.group === "apikey")?.rows.map((row) => row.action)).toEqual(["Connect"]);
    expect(groups.find((group) => group.group === "local")?.rows.map((row) => row.id)).toEqual(["local"]);
    expect(groups.find((group) => group.group === "custom")?.rows.map((row) => row.action)).toEqual(["Set up"]);
  });

  test("does not invent a Google row the catalog does not offer", () => {
    expect(onboardingRows(keys, oauth).some((row) => row.id === "google")).toBe(false);
  });
});

describe("markForProvider", () => {
  test("maps catalog ids onto the mockup logos", () => {
    expect(markForProvider("anthropic")).toContain("anthropic");
    expect(markForProvider("codex-oauth")).toContain("openai");
    expect(markForProvider("local")).toContain("ollama");
    expect(markForProvider("compatible")).toBeNull();
  });
});

describe("needsModelChoice", () => {
  test("a provider with a selected model never triggers the model step", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: "model-a", models: ["model-a", "model-b"] })).toBe(false);
  });

  test("a ready provider with an unmade multi-model choice still does", () => {
    expect(needsModelChoice({ status: "ready", selectedModel: null, models: ["model-a", "model-b"] })).toBe(true);
  });
});

describe("Onboarding shell", () => {
  test("pins the brand, whisper track, welcome points and credit", () => {
    const html = renderToStaticMarkup(
      createElement(Onboarding, {
        providers: [],
        apiKeyProviders: keys,
        oauthCandidates: oauth,
        onConnected: async () => {},
        onCreated: () => {},
        onSkipProject: () => {},
      }),
    );
    expect(html).toContain("ob-brand");
    expect(html).toContain("Solutions Builder");
    expect(html).toContain("ob-track");
    expect(html).toContain("ob-credit");
    expect(html).toContain("Powered by Corbits");
    expect(html).toContain("Welcome.");
    expect(html).toContain("Stages, not chat.");
    expect(html).not.toContain("Your name");
    expect(html).not.toContain("Notifications");
    expect(html).not.toContain("Open at login");
  });
});
