import { describe, expect, test } from "bun:test";
import { newestOfKind, prdForPeopleStale } from "./use-prd-for-people.ts";
import type { ArtifactNode } from "../../client.ts";

function node(overrides: Partial<ArtifactNode>): ArtifactNode {
  return {
    id: "n",
    kind: "product_requirements",
    variant: null,
    stage: 6,
    title: "t",
    version: 1,
    position: 1,
    artifactId: "a",
    contentHash: "a@1",
    createdAt: "2026-10-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
    ...overrides,
  };
}

describe("prdForPeopleStale", () => {
  const at = (iso: string) => ({ createdAt: iso });
  test("nothing to write without a PRD; missing or older than the PRD or the design is stale", () => {
    expect(prdForPeopleStale(null, null, at("2026-10-02T00:00:00Z"))).toBe(false);
    expect(prdForPeopleStale(null, at("2026-10-01T00:00:00Z"), null)).toBe(true);
    expect(prdForPeopleStale(at("2026-10-03T00:00:00Z"), at("2026-10-01T00:00:00Z"), at("2026-09-30T00:00:00Z"))).toBe(false);
    expect(prdForPeopleStale(at("2026-10-03T00:00:00Z"), at("2026-10-04T00:00:00Z"), null)).toBe(true);
    expect(prdForPeopleStale(at("2026-10-03T00:00:00Z"), at("2026-10-01T00:00:00Z"), at("2026-10-05T00:00:00Z"))).toBe(true);
  });
});

describe("newestOfKind", () => {
  test("the highest unsuperseded version of the kind, or null", () => {
    const nodes = [node({ id: "v1", version: 1 }), node({ id: "v2", version: 2 }), node({ id: "old", version: 3, supersededByNodeId: "x" }), node({ id: "d", kind: "design_artifact" })];
    expect(newestOfKind(nodes, "product_requirements")?.id).toBe("v2");
    expect(newestOfKind(nodes, "prd_for_people")).toBeNull();
  });
});
