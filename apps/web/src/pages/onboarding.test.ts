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
import type { Provider } from "../client.js";

const oauth = [{ providerId: "codex-oauth", label: "ChatGPT (Codex)", redirectUri: "x" }];
const keys = [
  { providerId: "anthropic", label: "Anthropic", needsBaseUrl: false },
  { providerId: "compatible", label: "OpenAI-compatible endpoint", needsBaseUrl: true },
];

const readyProvider: Provider = {
  id: "p1",
  providerId: "anthropic",
  label: "Anthropic",
  kind: "api_key",
  baseUrl: null,
  status: "ready",
  statusDetail: null,
  models: ["claude"],
  active: true,
  priority: 0,
  hasCredential: true,
  validatedAt: null,
  selectedModel: "claude",
};

function props(overrides: Partial<Parameters<typeof Onboarding>[0]> = {}) {
  return {
    providers: [] as Provider[],
    apiKeyProviders: keys,
    oauthCandidates: oauth,
    onConnected: async () => {},
    onCreated: () => {},
    onSkipProject: () => {},
    ...overrides,
  };
}

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
  test("welcome Skip and Get started render enabled, not as a form submit", () => {
    const html = renderToStaticMarkup(createElement(Onboarding, props()));
    expect(html).toContain("Skip setup");
    expect(html).toContain("Get started");
    expect(html).toContain('type="button"');
    expect(html).not.toMatch(/disabled[^>]*>Get started/);
    expect(html).not.toMatch(/disabled[^>]*>Skip setup/);
  });

  test("pins the brand, whisper track, welcome points and credit", () => {
    const html = renderToStaticMarkup(createElement(Onboarding, props()));
    expect(html).toContain("ob-brand");
    expect(html).toContain("Solution Builder");
    expect(html).toContain("ob-track");
    expect(html).toContain("ob-credit");
    expect(html).toContain("Powered by Corbits");
    expect(html).toContain("Welcome.");
    expect(html).toContain("Stages, not chat.");
    expect(html).not.toContain("Your name");
    expect(html).not.toContain("Notifications");
    expect(html).not.toContain("Open at login");
  });

  test("the last step uses the home composer-box chrome", () => {
    const html = renderToStaticMarkup(createElement(Onboarding, props({ providers: [readyProvider] })));
    expect(html).toContain("What problem are you trying to solve?");
    expect(html).toContain("composer-box");
    expect(html).toContain("ob-skip");
  });
});

describe("onboarding layout 1:1", () => {
  test("provider footer Skip leaves; Continue is type=button and disabled until a provider is ready", async () => {
    const page = await Bun.file(new URL("./onboarding.tsx", import.meta.url)).text();
    const provider = page.slice(page.indexOf("function ProviderStep"), page.indexOf("function ProviderMark"));
    const foot = provider.slice(provider.indexOf('className="ob-foot"'));
    expect(foot).toContain('className="ob-skip"');
    expect(foot).toContain("Skip for now");
    expect(foot).toContain("onClick={onSkip}");
    expect(foot).toContain('className="btn primary"');
    expect(foot).toContain("Continue");
    expect(foot).toContain("onClick={onContinue}");
    expect(foot).toContain('type="button"');
    expect(foot).toContain('disabled={busy !== null || !providers.some((provider) => provider.status === "ready")}');
    const skipBtn = foot.slice(foot.indexOf('className="ob-skip"'), foot.indexOf("Skip for now"));
    expect(skipBtn).not.toContain("disabled");
    expect(page).toContain('onSkip={() => setStep("project")}');
  });

  test("welcome Skip and Get started are type=button with click handlers", async () => {
    const page = await Bun.file(new URL("./onboarding.tsx", import.meta.url)).text();
    const welcome = page.slice(page.indexOf("function WelcomeStep"), page.indexOf("function LookStep"));
    expect(welcome).toContain("Skip setup");
    expect(welcome).toContain("Get started");
    expect(welcome).toContain("onClick={onSkip}");
    expect(welcome).toContain("onClick={onNext}");
    expect(welcome).toContain('type="button"');
    expect(welcome).not.toContain("disabled");
  });

  test("look theme segs, Connect/Detect, and model skip keep their click handlers", async () => {
    const page = await Bun.file(new URL("./onboarding.tsx", import.meta.url)).text();
    const look = page.slice(page.indexOf("function LookStep"), page.indexOf("function ProviderStep"));
    expect(look).toContain("onClick={() => setMode(option.id)}");
    expect(look).toContain("onClick={onNext}");
    const provider = page.slice(page.indexOf("function ProviderStep"), page.indexOf("function ProviderMark"));
    expect(provider).toContain("void connect(row)");
    expect(provider).toContain("api.connectLocalProvider");
    expect(provider).toContain("openAsk(row)");
    const model = page.slice(page.indexOf("function ModelStep"), page.indexOf("function ProjectStep"));
    expect(model).toContain("onClick={() => void choose(null)}");
    expect(model).toContain("onClick={() => void choose(picked)}");
    expect(model).toContain('type="button"');
  });

  test("group labels are first-of-step, not first-of-wrapper", async () => {
    const page = await Bun.file(new URL("./onboarding.tsx", import.meta.url)).text();
    const css = await Bun.file(new URL("./onboarding-layout.css", import.meta.url)).text();
    expect(page).toContain("<Fragment key={group.group}>");
    expect(page).not.toContain("<div key={group.group}>");
    expect(css).toContain(".ob-step > .ob-group:first-child");
    expect(css.replaceAll(".ob-step > .ob-group:first-child", "")).not.toContain(".ob-group:first-child");
  });

  test("the last-step mic sits in ChatInput leadingTools", async () => {
    const page = await Bun.file(new URL("./onboarding.tsx", import.meta.url)).text();
    const css = await Bun.file(new URL("./onboarding-layout.css", import.meta.url)).text();
    expect(page).toContain("leadingTools={mic}");
    expect(page).toContain("sendIcon");
    expect(css).toContain(".ob .composer-box");
    expect(css).toContain(".ob .ask .dictate");
    expect(css).toContain('[data-slot="chat-input-footer"]');
    expect(css).not.toContain("left: calc(var(--space-4) + 30px + 4px)");
  });
});
