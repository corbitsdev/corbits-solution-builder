import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "./client.ts";
import { audienceRoles, packageOfDeck } from "./deck-current.ts";

function node(overrides: Partial<ArtifactNode> & Pick<ArtifactNode, "id" | "kind" | "createdAt">): ArtifactNode {
  return { variant: "Joe", stage: 5, title: overrides.id, version: 1, position: 1, artifactId: overrides.id, contentHash: `${overrides.id}@1`, supersededByNodeId: null, provenance: { producer: "agent" }, ...overrides };
}

describe("packageOfDeck", () => {
  test("the newest package of the same stakeholder written before the deck, else the newest", () => {
    const nodes = [
      node({ id: "p1", kind: "audience_package", createdAt: "2026-10-01T00:00:00Z" }),
      node({ id: "p2", kind: "audience_package", createdAt: "2026-10-03T00:00:00Z" }),
      node({ id: "other", kind: "audience_package", variant: "Tim", createdAt: "2026-10-02T00:00:00Z" }),
    ];
    expect(packageOfDeck(nodes, { stage: 5, variant: "Joe", createdAt: "2026-10-02T00:00:00Z" })?.id).toBe("p1");
    expect(packageOfDeck(nodes, { stage: 5, variant: "Joe", createdAt: "2026-09-30T00:00:00Z" })?.id).toBe("p2");
    expect(packageOfDeck(nodes, { stage: 5, variant: "Nobody", createdAt: "2026-10-02T00:00:00Z" })).toBeNull();
  });
});

describe("audienceRoles", () => {
  test("maps names to roles off the policy and tolerates a missing one", () => {
    expect([...audienceRoles({ audiences: [{ name: "Joe", role: "approver" }, { name: "Tim" }] })]).toEqual([["Joe", "approver"], ["Tim", ""]]);
    expect(audienceRoles(null).size).toBe(0);
  });
});
