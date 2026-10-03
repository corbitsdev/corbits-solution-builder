import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "../../stage-mail.ts";
import { SpecialistTurn, StageConversation } from "./thread.tsx";
import type { DraftRef } from "./draft-references.ts";

const BRIEF = [
  "Here is the brief, with your answers folded in.",
  "",
  "# Problem brief",
  "",
  "## In short",
  "",
  "Field crews lose an hour a day re-entering readings that the handheld already captured, because the sync drops on the way back to the depot.",
  "",
  "## Who is affected",
  "",
  "Every crew lead across the twelve depots, and the dispatchers who chase the missing readings each evening before the report is due.",
  "",
  "## What I need from you",
  "",
  "Which depots should the pilot cover?",
  "",
  "- Option: North region",
  "- Option: All twelve",
].join("\n");

const DESIGN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Inteva Complete – Stage 4 Interface</title>
<style>:root { --surface: #f8fafc; --panel: #ffffff; --text: #111827; } body { margin: 0; background: var(--surface); color: var(--text); font-family: Arial, Helvetica, sans-serif; } button { min-height: 44px; min-width: 44px; border: 1px solid var(--line); border-radius: 10px; }</style></head>
<body><main><h1>Design review</h1><section><h2>Projects</h2><p>Every project in one governed workspace.</p></section></main></body></html>`;

function render(messages: ChatMessage[]): string {
  return renderToStaticMarkup(
    createElement(StageConversation, {
      messages,
      value: "",
      onValueChange: () => undefined,
      onSend: () => undefined,
    }),
  );
}

describe("StageConversation message bodies", () => {
  test("a person's HTML document (stage 5's opening carries the approved design) is a sandboxed frame, not markup as text", () => {
    const html = render([{ id: "m1", author: "me", body: DESIGN, at: "2026-09-23T00:00:00.000Z" }]);
    expect(html).toContain('class="bubble-document"');
    expect(html).toContain('sandbox=""');
    expect(html.toLowerCase()).toContain("srcdoc=");
    // The document's own markup is only ever inside the frame's srcdoc, never rendered as the bubble's text.
    const outsideFrame = html.replace(/<iframe[^>]*><\/iframe>/, "");
    expect(outsideFrame).not.toContain("doctype");
    expect(outsideFrame).not.toContain("--surface");
  });

  test("a person's ordinary text stays Markdown", () => {
    const html = render([{ id: "m1", author: "me", body: "Keep the **native** approach.", at: "2026-09-23T00:00:00.000Z" }]);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("<strong>native</strong>");
  });

  test("a specialist's HTML reply keeps its short lead", () => {
    const html = render([{ id: "m1", author: "agent", body: DESIGN, at: "2026-09-23T00:00:00.000Z" }]);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("First draft is in the document.");
  });

  // #158: a draft reply is a line naming its version, not the draft.
  test("a draft reply with a known version is one line naming it, and the pointer is not repeated", () => {
    const html = renderToStaticMarkup(
      createElement(StageConversation, {
        messages: [{ id: "m1", author: "agent", body: BRIEF, at: "2026-09-23T00:00:00.000Z" }],
        value: "",
        onValueChange: () => undefined,
        onSend: () => undefined,
        draftRefs: new Map([["m1", { version: 2, nodeId: "n2", noun: "problem brief" }]]),
        onOpenVersion: () => undefined,
      }),
    );
    expect(html).toContain("Drafted v2 of the problem brief");
    expect(html).toContain('class="turn-version"');
    expect(html).toContain("with your answers folded in");
    expect(html).not.toContain("In short");
    expect(html).not.toContain("First draft is in the document.");
  });
});

describe("SpecialistTurn drafts", () => {
  const render = (draft: DraftRef | null) =>
    renderToStaticMarkup(createElement(SpecialistTurn, { text: BRIEF, note: null, draft, onOpenVersion: () => undefined, onAnswer: () => undefined }));

  // #158: the draft's text and headings stay in the document pane; its
  // lead and the question it asks stay in the chat.
  test("a draft turn is a line naming its version, its lead, and its question -- never its headings or body", () => {
    const html = render({ version: 2, nodeId: "n2", noun: "problem brief" });
    expect(html).toContain("Drafted v2 of the problem brief");
    expect(html).toContain('class="turn-version"');
    expect(html).toContain("with your answers folded in");
    expect(html).not.toContain("In short");
    expect(html).not.toContain("Who is affected");
    expect(html).not.toContain("hour a day");
    expect(html).toContain('class="turn-question"');
    expect(html).toContain("Which depots should the pilot cover?");
    expect(html.match(/class="turn-option"/g)?.length).toBe(2);
  });

  test("a draft with no version recorded yet is named without one, with nothing to open", () => {
    const html = render({ version: null, nodeId: null, noun: "problem brief" });
    expect(html).toContain("Drafted the problem brief");
    expect(html).not.toContain('class="turn-version"');
    expect(html).not.toContain("In short");
  });

  test("a plain reply still shows in full", () => {
    const html = render(null);
    expect(html).toContain("In short");
    expect(html).toContain("hour a day");
    expect(html).not.toContain("Drafted");
  });
});

describe("SpecialistTurn questions", () => {
  test("a turn asking two questions with options sets both apart, each with its own tappable options", () => {
    const text = [
      "What should the default be for the bystander photo setting?",
      "",
      "- Option: Warn me before saving",
      "- Option: Block saving",
      "",
      "Which cloud recognition service should settings support first?",
      "",
      "- Option: Pick a common service during the build",
      "- Option: I will name a specific service later",
    ].join("\n");
    const html = renderToStaticMarkup(createElement(SpecialistTurn, { text, note: null, onOpenVersion: () => undefined, onAnswer: () => undefined }));
    expect(html.match(/class="turn-question"/g)?.length).toBe(2);
    expect(html.match(/class="turn-option"/g)?.length).toBe(4);
    expect(html.indexOf("bystander")).toBeLessThan(html.indexOf("cloud recognition"));
    // No chip is chosen until tapped (#142).
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('aria-pressed="true"');
  });
});
