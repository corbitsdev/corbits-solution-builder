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
  test("status orange is brand-primary, cards reveal their menu on hover, composer uses icon slots", async () => {
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
    expect(page).toContain("project-card-menu");
    expect(page).toContain("Ellipsis");
    expect(css).toContain(".home-page .card.needs");
    expect(css).toContain("border-color: var(--brand-primary)");
    expect(css).toContain(".home-page .badge-decision");
    expect(css).toContain("background: var(--brand-primary)");
    expect(css).toContain(".home-page .card-track .seg.now");
    expect(css).toContain("composer-foot");
    expect(css).toContain('[data-slot="chat-input-footer"]');
    expect(css).toContain(".home-page .card:hover .project-card-menu");
    expect(css).not.toContain("M5 12h14");
    expect(css).not.toContain("-webkit-mask");
    expect(css).toContain("var(--wb-foreground)");
    expect(css).toContain("var(--wb-background)");
  });
});

describe("project card menu", () => {
  test("offers info, rename, export, archive and a two-step delete without reaching the card's open handlers", async () => {
    const page = await Bun.file(new URL("./projects.tsx", import.meta.url)).text();
    const card = page.slice(page.indexOf("function ProjectCard"), page.indexOf("function ProjectInfoDialog"));
    expect(card).toContain("<MenuTrigger asChild>");
    for (const item of ["Project info…", "Rename", "Export…", "Archive", "Unarchive", "Delete…", "Yes, delete it"]) expect(card).toContain(item);
    expect(card).toContain("exportProjectBundle(project)");
    expect(card).toContain("api.updateProject(project.id, { archived: !project.archivedAt })");
    expect(card).toContain("api.deleteProject(project.id)");
    // A slip cannot delete: the confirming item only exists after Delete… was chosen, and closing the menu forgets it.
    expect(card).toContain("setConfirming(true)");
    expect(card).toMatch(/if \(!open\) \{[^}]*setConfirming\(false\);/);
    // The card face opens the project on click and long-press; the menu must not.
    const menuWrapper = card.slice(card.indexOf('className="card-menu"'), card.indexOf("<Menu "));
    for (const handler of ["onClick", "onPointerDown", "onContextMenu", "onKeyDown"]) expect(menuWrapper).toContain(`${handler}={(event) => event.stopPropagation()}`);
    // Nor may the info dialog, portaled but React-nested in the card.
    const dialogWrapper = card.slice(card.indexOf('className="card-dialog"'), card.indexOf("<ProjectInfoDialog"));
    for (const handler of ["onClick", "onPointerDown", "onContextMenu", "onKeyDown"]) expect(dialogWrapper).toContain(`${handler}={(event) => event.stopPropagation()}`);
    // While the menu or dialog is up, and just after it closes, the face itself is inert (card-face-guard.ts).
    expect(card).toContain("setMenuOpen(open)");
    expect(card).toContain("closedAt.current = Date.now()");
    expect(card).toContain("if (opens) onOpen();");
    expect(card).toContain("if (!faceOpens()) return;");
    expect(card).toContain("onPointerDownOutside={() => (dismissing.current = true)}");
  });

  test("the menu renders closed: only its trigger is in the markup", () => {
    const html = renderToStaticMarkup(
      createElement(Projects, { projects: [summary()], onOpen: () => undefined, onChanged: () => undefined }),
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain("Yes, delete it");
    expect(html).not.toContain("Export…");
  });
});

describe("project info actions", () => {
  test("rename, export, archive, and delete also live in ProjectInfoDialog, opened by the menu, context menu or long-press", async () => {
    const page = await Bun.file(new URL("./projects.tsx", import.meta.url)).text();
    const dialog = page.slice(page.indexOf("function ProjectInfoDialog"));
    expect(page).toContain("onContextMenu");
    expect(page).toContain("LONG_PRESS_MS");
    expect(page).toContain("setTimeout(() => openInfo(), LONG_PRESS_MS)");
    expect(dialog).toContain("api.updateProject(project.id, { title: next })");
    expect(dialog).toContain("exportProjectBundle(project)");
    expect(page).toContain("assembleBundle(project.id");
    expect(dialog).toContain('api.updateProject(project.id, { archived: !project.archivedAt })');
    expect(dialog).toContain("api.deleteProject(project.id)");
    expect(dialog).toContain("Export…");
    expect(dialog).toContain("Archive");
    expect(dialog).toContain("Delete…");
    expect(dialog).toContain("Yes, delete it");
  });
});
