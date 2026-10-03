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
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Projects markup", () => {
  test("live cards render a card-desc from the list title, keep create/import, and carry the options menu", () => {
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
    expect(html).toContain("card-top");
    expect(html).toContain("card-track");
    expect(html).toContain("card-foot");
    expect(html).toContain("project-card-menu");
    expect(html).toContain('aria-label="Options for Orbit payroll migration"');
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

describe("project card menu", () => {

  test("the menu renders closed: only its trigger is in the markup", () => {
    const html = renderToStaticMarkup(
      createElement(Projects, { projects: [summary()], onOpen: () => undefined, onChanged: () => undefined }),
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain("Yes, delete it");
    expect(html).not.toContain("Export…");
  });
});

