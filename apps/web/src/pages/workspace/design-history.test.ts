import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "../../client.ts";
import { designHistory } from "./design-history.ts";

const node = (id: string, createdAt: string, kind = "design_artifact", version = 1): ArtifactNode => ({
  id,
  kind,
  variant: null,
  stage: 4,
  title: "Stage 4 draft",
  version,
  position: version,
  artifactId: id,
  contentHash: `${id}@${String(version)}`,
  sizeBytes: 10,
  mediaType: "text/markdown",
  createdAt,
  supersededByNodeId: null,
  provenance: { producer: "agent", agentRole: "experience-designer" },
});

describe("designHistory", () => {
  test("orders every design by when it was saved, whatever the graph's order and the artifacts' own versions (#86)", () => {
    const nodes = [
      node("mockup", "2026-09-26T10:46:00.000Z"),
      node("approach-text", "2026-09-26T08:25:00.000Z"),
      node("brief", "2026-09-26T08:20:00.000Z", "problem_brief"),
      node("error-reply", "2026-09-26T08:26:00.000Z"),
    ];
    const history = designHistory(nodes);
    expect(history.map((entry) => entry.id)).toEqual(["approach-text", "error-reply", "mockup"]);
    expect(history.at(-1)?.id).toBe("mockup");
  });
});
