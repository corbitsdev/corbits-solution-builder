import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { revisionRequest } from "@solutions-builder/app/stage-prompt";
import type { ArtifactNode, StageTurn } from "../../client.ts";
import { StageDocument } from "./document.tsx";

function node(): ArtifactNode {
  return {
    id: "art_1",
    kind: "problem_statement",
    variant: null,
    stage: 1,
    title: "Problem brief",
    version: 6,
    artifactId: "art_1",
    contentHash: "art_1@6",
    createdAt: "2026-10-02T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
  };
}

describe("StageDocument reads a revision mail as the person's words", () => {
  test("the revision envelope stays out of the transcript", () => {
    const ask = "100% agent driven. Have you seen graphite.dev and Cursor Review?";
    const turn: StageTurn = {
      id: "m1",
      role: "human",
      body: revisionRequest({ stage: 1, userInput: ask, currentDocument: "## In short\n- Reviews may merge on their own.\n" }),
      quotes: [],
      resultNodeId: null,
      questions: null,
      createdAt: "2026-10-02T14:39:00.000Z",
    };
    const html = renderToStaticMarkup(
      createElement(StageDocument, {
        node: node(),
        versions: [node()],
        content: "## In short\n- Reviews may merge on their own.\n",
        tenantId: "tnt",
        turns: [turn],
        openQuestion: null,
        onSelectVersion: () => undefined,
        onRevise: () => undefined,
        onSubmit: () => undefined,
        soloApproval: true,
        canSubmit: false,
        busy: null,
      }),
    );
    expect(html).toContain(ask);
    expect(html).toContain("The version this revises");
    expect(html).not.toContain("WHAT THE PERSON IS ASKING FOR NOW");
    expect(html).not.toContain("Produce the next version");
  });
});
