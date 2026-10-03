import { describe, expect, test } from "bun:test";
import { stageEvents } from "./stage-events.ts";
import type { ArtifactNode } from "../../client.ts";
import type { DecisionRecord } from "@solutions-builder/app/project-workflow/contracts";

function node(over: Partial<ArtifactNode>): ArtifactNode {
  return {
    id: `n-${over.artifactId ?? "a"}`,
    kind: "document",
    variant: null,
    stage: 1,
    title: "Problem brief",
    version: 1,
    artifactId: "a",
    contentHash: "",
    sizeBytes: 10,
    mediaType: "text/markdown",
    createdAt: "2026-01-01T10:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "specialist" },
    ...over,
  };
}

function decision(over: Partial<DecisionRecord>): DecisionRecord {
  return {
    decisionId: "d1",
    kind: "approve",
    stage: 1,
    accepted: true,
    principalId: "p",
    at: "2026-01-01T11:00:00.000Z",
    ...over,
  };
}

describe("stageEvents", () => {
  test("scopes nodes to the stage and hides internal kinds", () => {
    const events = stageEvents(
      2,
      [],
      [
        node({ stage: 1 }),
        node({ stage: 2, kind: "withdrawn_turns", title: "markers" }),
        node({ stage: 2, kind: "source_material", title: "brand.pdf" }),
      ],
      [],
    );
    expect(events.map((e) => e.text)).toEqual(["Attached: brand.pdf"]);
  });

  test("send-back reads differently on the sending and receiving stage", () => {
    const sent = decision({ kind: "send_back", stage: 6, targetStage: 3, reason: "more card-driven" });
    const at6 = stageEvents(6, [sent], [], []);
    const at3 = stageEvents(3, [sent], [], []);
    expect(at6.at(-1)?.text).toBe('The owner sent this stage back to Solution proposal: “more card-driven”');
    expect(at3.at(-1)?.text).toBe('The owner sent this back here from Build plan: “more card-driven”');
  });

  test("withdrawn turns become aborted lines on their own stage only", () => {
    const marks = [
      { messageId: "m1", stage: 1, at: "2026-01-01T09:00:00.000Z" },
      { messageId: "m2", stage: 2, at: "2026-01-01T09:00:00.000Z" },
    ];
    expect(stageEvents(1, [], [], marks).map((e) => e.text)).toEqual(["The owner stopped this reply"]);
  });
});
