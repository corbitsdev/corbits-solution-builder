import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "../../client.ts";
import { packageForDeck, recordedDeckFileName } from "./deck-reader.tsx";

function node(overrides: Partial<ArtifactNode> & Pick<ArtifactNode, "id" | "kind" | "createdAt">): ArtifactNode {
  return {
    variant: "Brian J. Fox Architect",
    stage: 5,
    title: overrides.id,
    version: 1,
    position: 1,
    artifactId: overrides.id,
    contentHash: "",
    supersededByNodeId: null,
    provenance: { producer: "specialist" },
    ...overrides,
  };
}

// #249: the slides were built from the package standing when they were
// recorded, so that is the one their preview is drawn from.
describe("packageForDeck", () => {
  const nodes = [
    node({ id: "pkg1", kind: "audience_package", version: 1, createdAt: "2026-09-01T10:00:00.000Z", supersededByNodeId: "pkg2" }),
    node({ id: "deck1", kind: "audience_deck", version: 1, createdAt: "2026-09-01T10:05:00.000Z" }),
    node({ id: "pkg2", kind: "audience_package", version: 2, createdAt: "2026-09-02T10:00:00.000Z" }),
    node({ id: "other", kind: "audience_package", version: 1, variant: "Joe Filerman", createdAt: "2026-09-01T09:00:00.000Z" }),
    node({ id: "brief", kind: "problem_brief", stage: 1, variant: null, createdAt: "2026-08-01T09:00:00.000Z" }),
  ];

  test("picks the same stakeholder's newest package that already existed when the deck was recorded", () => {
    expect(packageForDeck(nodes, nodes[1]!)?.id).toBe("pkg1");
  });

  test("falls back to the newest package when every one is newer than the deck", () => {
    const early = node({ id: "deck0", kind: "audience_deck", createdAt: "2026-08-31T00:00:00.000Z" });
    expect(packageForDeck(nodes, early)?.id).toBe("pkg2");
  });

  test("is null when that stakeholder has no package in the record", () => {
    const lone = node({ id: "deckX", kind: "audience_deck", variant: "Tim Burke", createdAt: "2026-09-01T10:05:00.000Z" });
    expect(packageForDeck(nodes, lone)).toBeNull();
  });
});

describe("recordedDeckFileName", () => {
  test("gives the recorded file its extension once", () => {
    expect(recordedDeckFileName("Slides for Brian")).toBe("Slides for Brian.pptx");
    expect(recordedDeckFileName("slides.PPTX")).toBe("slides.PPTX");
  });
});
