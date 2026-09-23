import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "../../stage-mail.ts";
import { StageConversation } from "./thread.tsx";

const DESIGN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Inteva Complete – Stage 4 Interface</title>
<style>:root { --surface: #f8fafc; --panel: #ffffff; --text: #111827; } body { margin: 0; background: var(--surface); color: var(--text); font-family: Arial, Helvetica, sans-serif; } button { min-height: 44px; min-width: 44px; border: 1px solid var(--line); border-radius: 10px; }</style></head>
<body><main><h1>Design review</h1><section><h2>Projects</h2><p>Every project in one governed workspace.</p></section></main></body></html>`;

function render(messages: ChatMessage[]): string {
  return renderToStaticMarkup(
    createElement(StageConversation, {
      stage: 5,
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
});
