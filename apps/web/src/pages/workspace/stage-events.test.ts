import { describe, expect, test } from "bun:test";
import { eventMessages, stageEvents } from "./stage-events.ts";
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
  test("opens with the stage boundary, then orders by time", () => {
    const events = stageEvents(
      1,
      [decision({ kind: "open_review", artifactId: "a", version: 2, at: "2026-01-01T12:00:00.000Z" })],
      [node({ version: 1 }), node({ id: "n-a2", version: 2, createdAt: "2026-01-01T11:30:00.000Z" })],
      [],
    );
    expect(events[0]?.tone).toBe("boundary");
    expect(events[0]?.text).toContain("Stage 1");
    expect(events.map((e) => e.text)).toEqual([
      "Stage 1 · Problem discovery",
      "Problem brief · v1",
      "Problem brief · v2",
      "Review opened · Problem brief v2",
    ]);
  });

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
    expect(events.map((e) => e.text)).toEqual(["Stage 2 · Solution shape", "Attached · brand.pdf"]);
  });

  test("send-back reads differently on the sending and receiving stage", () => {
    const sent = decision({ kind: "send_back", stage: 6, targetStage: 3, reason: "more card-driven" });
    const at6 = stageEvents(6, [sent], [], []);
    const at3 = stageEvents(3, [sent], [], []);
    expect(at6.at(-1)?.text).toBe('Sent back · to Solution proposal · “more card-driven”');
    expect(at3.at(-1)?.text).toBe('Returned · sent back from Build plan · “more card-driven”');
  });

  test("withdrawn turns become aborted lines on their own stage only", () => {
    const marks = [
      { messageId: "m1", stage: 1, at: "2026-01-01T09:00:00.000Z" },
      { messageId: "m2", stage: 2, at: "2026-01-01T09:00:00.000Z" },
    ];
    expect(stageEvents(1, [], [], marks).map((e) => e.text)).toEqual([
      "Stage 1 · Problem discovery",
      "Turn aborted",
    ]);
  });
});

describe("eventMessages", () => {
  test("interleaves system rows into the transcript by timestamp", () => {
    const merged = eventMessages(
      [
        {
          id: "t1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: "2026-01-01T10:30:00.000Z",
        },
      ],
      stageEvents(1, [], [node({})], []),
    );
    expect(merged.map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(merged[0]?.id).toBe("ev:boundary");
  });
});
