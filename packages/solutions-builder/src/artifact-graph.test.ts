import { describe, expect, test } from "bun:test";
import { foldArtifactGraph, versionIdFor, type ArtifactListEntry } from "./artifact-graph.js";

function entry(
  id: string,
  version: number,
  title: string,
  sb: Record<string, unknown> | null,
): ArtifactListEntry {
  return { id, version, title, createdAt: `2026-01-0${version}T00:00:00.000Z`, metadata: sb ? { sb } : null };
}

describe("foldArtifactGraph", () => {
  const brief = entry("art_brief", 1, "Problem brief", {
    projectId: "proj_1",
    kind: "problem_brief",
    stage: 1,
    sourceVersionIds: [],
    provenance: { producer: "human" },
  });
  const constraints = entry("art_constraints", 1, "Solution constraints", {
    projectId: "proj_1",
    kind: "solution_constraints",
    stage: 2,
    sourceVersionIds: [versionIdFor("art_brief", 1)],
    provenance: { producer: "agent", agentRole: "constraints", model: "sonnet" },
  });
  const otherProject = entry("art_other", 1, "Unrelated brief", {
    projectId: "proj_2",
    kind: "problem_brief",
    stage: 1,
    sourceVersionIds: [],
    provenance: { producer: "human" },
  });

  test("filters by metadata.sb.projectId", () => {
    const graph = foldArtifactGraph([brief, constraints, otherProject], "proj_1");
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["art_brief", "art_constraints"]);
  });

  test("folds fields into the ProjectDetail.nodes shape", () => {
    const graph = foldArtifactGraph([brief, constraints], "proj_1");
    const node = graph.nodes.find((n) => n.id === "art_constraints");
    expect(node).toMatchObject({
      id: "art_constraints",
      versionId: "art_constraints@1",
      kind: "solution_constraints",
      stage: 2,
      variant: null,
      title: "Solution constraints",
      supersededByNodeId: null,
      provenance: { producer: "agent", agentRole: "constraints", model: "sonnet" },
    });
  });

  test("derives edges from sourceVersionIds", () => {
    const graph = foldArtifactGraph([brief, constraints], "proj_1");
    expect(graph.edges).toEqual([{ childNodeId: "art_constraints", sourceNodeId: "art_brief" }]);
  });

  test("derives supersededByNodeId from the inverse of supersedes", () => {
    const revised = entry("art_brief_v2", 1, "Problem brief (revised)", {
      projectId: "proj_1",
      kind: "problem_brief",
      stage: 1,
      supersedes: "art_brief",
      sourceVersionIds: [],
      provenance: { producer: "human" },
    });
    const graph = foldArtifactGraph([brief, revised], "proj_1");
    const original = graph.nodes.find((n) => n.id === "art_brief");
    const replacement = graph.nodes.find((n) => n.id === "art_brief_v2");
    expect(original?.supersededByNodeId).toBe("art_brief_v2");
    expect(replacement?.supersededByNodeId).toBeNull();
  });

  test("drops artifacts with no sb metadata yet", () => {
    const bare = entry("art_bare", 1, "Uploaded file", null);
    const graph = foldArtifactGraph([brief, bare], "proj_1");
    expect(graph.nodes.map((n) => n.id)).toEqual(["art_brief"]);
  });
});
