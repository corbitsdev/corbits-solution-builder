/**
 * The two leads a stage can hand `StageDocument` (#619): Cost approval's
 * estimate summary heads the document pane, and its target question sits in
 * the chat column above the box. Neither sits above the panes, where the
 * two together took the window from the conversation and the document.
 */
import { describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactNode } from "../../client.js";
import { StageDocument } from "./document.tsx";

const NODE: ArtifactNode = {
  id: "n1",
  kind: "cost_approval",
  variant: null,
  stage: 7,
  title: "Cost",
  version: 1,
  artifactId: "a1",
  contentHash: "",
  sizeBytes: 1,
  mediaType: "text/markdown",
  createdAt: "2026-10-03T00:00:00Z",
  supersededByNodeId: null,
  provenance: { producer: "specialist" },
};

function render(leads: { documentLead?: ReactNode; composerLead?: ReactNode }): string {
  return renderToStaticMarkup(
    createElement(StageDocument, {
      node: NODE,
      versions: [NODE],
      content: "## In short\n\nThe estimate's own text.",
      tenantId: "t",
      turns: [],
      openQuestion: null,
      onSelectVersion: () => undefined,
      onRevise: () => undefined,
      onChoose: () => undefined,
      onSubmit: () => undefined,
      soloApproval: true,
      canSubmit: false,
      busy: null,
      ...leads,
    }),
  );
}

describe("StageDocument leads", () => {
  test("the document lead heads the document pane, above the document's text", () => {
    const html = render({ documentLead: createElement("div", { id: "summary" }, "SUMMARY") });
    const pane = html.indexOf('class="stage-inner"');
    const lead = html.indexOf('id="summary"');
    const doc = html.indexOf('class="doc"');
    expect(pane).toBeGreaterThan(-1);
    expect(lead).toBeGreaterThan(pane);
    expect(doc).toBeGreaterThan(lead);
    expect(html.indexOf("The estimate")).toBeGreaterThan(doc);
  });

  test("the composer lead sits in the chat column, above the message box", () => {
    const html = render({ composerLead: createElement("div", { id: "question" }, "QUESTION") });
    const composer = html.indexOf('class="composer"');
    const lead = html.indexOf('id="question"');
    expect(composer).toBeGreaterThan(-1);
    expect(lead).toBeGreaterThan(composer);
    expect(html.indexOf("<textarea")).toBeGreaterThan(lead);
    // In the conversation, not the document pane beside it.
    expect(lead).toBeLessThan(html.indexOf('class="stage-inner"'));
  });

  test("without leads, neither pane gains anything", () => {
    const html = render({});
    expect(html).toContain('<div class="stage-inner"><div class="doc"');
  });
});
