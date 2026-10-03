import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "./client.js";
import { packagesByStakeholder } from "./package-lineages.ts";

function node(partial: Partial<ArtifactNode> & { id: string }): ArtifactNode {
  return {
    kind: "audience_package",
    stage: 5,
    title: `${partial.variant ?? "draft"}'s package`,
    version: 1,
    variant: null,
    supersededByNodeId: null,
    createdAt: "2026-09-26T17:00:00.000Z",
    ...partial,
  } as ArtifactNode;
}

const audiences = [{ name: "You" }, { name: "Mr Tech" }, { name: "Mr Finance" }];

// #122: one tab per stakeholder, however many live nodes the graph holds.
describe("packagesByStakeholder", () => {
  test("keeps the newest live package for each stakeholder, in the stakeholders' order", () => {
    const shown = packagesByStakeholder(
      [
        node({ id: "fin", variant: "Mr Finance" }),
        node({ id: "you-1", variant: "You", version: 1 }),
        node({ id: "you-2", variant: "You", version: 2, createdAt: "2026-09-26T18:00:00.000Z" }),
        node({ id: "tech", variant: "Mr Tech" }),
      ],
      audiences,
    );
    expect(shown.map((entry) => entry.id)).toEqual(["you-2", "tech", "fin"]);
  });

  test("a superseded package, another kind, and the stage's own unnamed draft are not stakeholder packages", () => {
    const shown = packagesByStakeholder(
      [
        node({ id: "old", variant: "You", supersededByNodeId: "new" }),
        node({ id: "new", variant: "You", version: 2 }),
        node({ id: "draft" }),
        node({ id: "design", variant: "You", kind: "design_artifact" }),
      ],
      audiences,
    );
    expect(shown.map((entry) => entry.id)).toEqual(["new"]);
  });

});
