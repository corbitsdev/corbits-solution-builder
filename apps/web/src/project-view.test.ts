import { describe, expect, test } from "bun:test";
import { resolveStage, toArtifactNode } from "./project-view.ts";
import type { ProjectWorkflowView } from "./project-workflow.ts";

function node(overrides: Partial<Parameters<typeof toArtifactNode>[0]> = {}) {
  return {
    id: "art-1",
    versionId: "art-1@1",
    kind: "source_material",
    stage: 1,
    variant: "report.pdf",
    title: "report.pdf",
    mediaType: "application/pdf",
    supersededByNodeId: null,
    provenance: { producer: "human" as const },
    createdAt: "2026-01-01T00:00:00.000Z",
    approvedAt: null,
    ...overrides,
  };
}

describe("toArtifactNode", () => {
  test("an uploaded file reports its real size, carried through the fold's own node", () => {
    const result = toArtifactNode(node({ sizeBytes: 4096 }));
    expect(result.sizeBytes).toBe(4096);
  });

  test("a legacy data-URL/text artifact maps with sizeBytes left unknown, never 0", () => {
    const result = toArtifactNode(node());
    expect(result.sizeBytes).toBeUndefined();
    expect(result).not.toHaveProperty("sizeBytes", 0);
  });

  test("still carries the rest of the node's fields through unchanged", () => {
    const result = toArtifactNode(node({ sizeBytes: 10 }));
    expect(result.id).toBe("art-1");
    expect(result.version).toBe(1);
    expect(result.artifactId).toBe("art-1");
    expect(result.mediaType).toBe("application/pdf");
  });
});

function workflowView(overrides: Partial<ProjectWorkflowView> = {}): ProjectWorkflowView {
  return {
    stage: 3,
    done: false,
    openReview: null,
    reviews: {},
    decisions: [],
    lastRefusal: null,
    allowed: { openReview: true, approve: false, sendBack: true },
    ...overrides,
  };
}

describe("resolveStage", () => {
  test("a workflow view present: the header/rail stage IS the workflow's own committed stage", () => {
    const result = resolveStage(workflowView({ stage: 3 }), []);
    expect(result).toEqual({ stage: 3, done: false, stageSource: "workflow" });
  });

  test("a converged (done) workflow: stage 9, regardless of the view's own stage field", () => {
    const result = resolveStage(workflowView({ stage: 8, done: true }), []);
    expect(result).toEqual({ stage: 9, done: true, stageSource: "workflow" });
  });

  test("no workflow yet: falls back to the artifact fold, never the workflow's stage", () => {
    const approvedStage1 = node({ stage: 1, kind: "problem_brief", approvedAt: "2026-01-01T00:00:00.000Z" });
    const result = resolveStage(null, [toArtifactNode(approvedStage1)]);
    expect(result).toEqual({ stage: 2, done: false, stageSource: "artifacts" });
  });
});
