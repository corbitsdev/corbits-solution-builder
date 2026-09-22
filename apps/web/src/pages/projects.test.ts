import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSummary } from "../client.ts";
import { Projects } from "./projects.tsx";

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "proj_1",
    revision: 1,
    title: "Orbit payroll migration",
    description: null,
    stage: null,
    archivedAt: null,
    needsDecision: true,
    waits: [],
    turn: "idle",
    runs: 2,
    ...overrides,
  };
}

describe("Projects markup", () => {
  test("live cards render a card-desc from the list title and keep create/import/menus", () => {
    const html = renderToStaticMarkup(
      createElement(Projects, {
        projects: [summary()],
        onOpen: () => undefined,
        onChanged: () => undefined,
      }),
    );
    expect(html).toContain("card-desc");
    expect(html).toContain("Orbit payroll migration");
    expect(html).toContain("Needs decision");
    expect(html).toContain("Import a project");
    expect(html).not.toContain("spend-box");
    expect(html).toContain('accept=".json,.zip,application/json,application/zip"');
    expect(html).toContain("composer-box");
    expect(html).toContain("project-card-menu");
    expect(html).toContain("Options for Orbit payroll migration");
    expect(html).not.toContain("ago");
  });

  test("card-desc uses the stored problem one-liner when the list carries it", () => {
    const html = renderToStaticMarkup(
      createElement(Projects, {
        projects: [summary({ description: "Move payroll cutoff + reconciliation off the legacy batch system." })],
        onOpen: () => undefined,
        onChanged: () => undefined,
      }),
    );
    expect(html).toContain("card-desc");
    expect(html).toContain("Move payroll cutoff + reconciliation off the legacy batch system.");
  });

  test("an empty list still uses the mockup empty card", () => {
    const html = renderToStaticMarkup(
      createElement(Projects, {
        projects: [],
        onOpen: () => undefined,
        onChanged: () => undefined,
      }),
    );
    expect(html).toContain("Nothing yet");
    expect(html).toContain("Describe the thing above — the discovery stage starts there.");
  });
});

describe("home composer send", () => {
  test("send still createProject behind the silent ten-character gate", async () => {
    const page = await Bun.file(new URL("./projects.tsx", import.meta.url)).text();
    expect(page).toContain("onSend={() => void start()}");
    expect(page).toContain("api.createProject");
    expect(page).toContain("if (!canStartProject(problem) || busy) return");
    expect(page).toContain("onAttach={addMaterial}");
    expect(page).toContain("void importFile(file)");
    expect(page).toContain("At least ten characters to start a project.");
    expect(page).toContain('className="visually-hidden"');
  });
});

describe("home layout sheet", () => {
  test("status orange is brand-primary, kebab is out of flow, composer uses icon slots", async () => {
    const page = await Bun.file(new URL("./projects.tsx", import.meta.url)).text();
    const css = await Bun.file(new URL("./home-layout.css", import.meta.url)).text();
    expect(page).toContain("cardDescription(project)");
    expect(page).toContain("className=\"card-desc\"");
    expect(page).toContain("ChatInput");
    expect(page).toContain("Dictated");
    expect(page).toContain("attachIcon");
    expect(page).toContain("sendIcon");
    expect(page).toContain("leadingTools");
    expect(page).toContain("Plus");
    expect(page).toContain("Send");
    expect(css).toContain(".home-page .card.needs");
    expect(css).toContain("border-color: var(--brand-primary)");
    expect(css).toContain(".home-page .badge-decision");
    expect(css).toContain("background: var(--brand-primary)");
    expect(css).toContain(".home-page .card-track .seg.now");
    expect(css).toContain("composer-foot");
    expect(css).toContain('[data-slot="chat-input-footer"]');
    expect(css).toContain("pointer-events: none");
    expect(css).not.toContain("M5 12h14");
    expect(css).not.toContain("-webkit-mask");
    expect(css).toContain("var(--wb-foreground)");
    expect(css).toContain("var(--wb-background)");
  });
});
