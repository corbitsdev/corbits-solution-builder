import { describe, expect, test } from "bun:test";
import type { ArtifactNode } from "./client.js";
import { bundleAdoptionPlan, bundlePosition, derivedStage } from "./bundle-adoption.ts";
import type { ProjectBundle } from "./project-export.ts";

const at = "2026-10-03T10:00:00.000Z";
let seq = 0;
function node(kind: string, stage: number, over: Partial<ArtifactNode> = {}): ArtifactNode {
  seq += 1;
  const id = over.id ?? `n${String(seq)}`;
  return { id, kind, variant: null, stage, title: kind, version: 1, artifactId: `a-${id}`, contentHash: "", createdAt: at, supersededByNodeId: null, provenance: { producer: "agent" }, ...over };
}
const PRD = "## Functional requirements\n\n- FR-1: It works.\n\n## Acceptance criteria\n\n- AC-1: It is seen to work.\n";
function bundle(over: Partial<ProjectBundle> = {}): ProjectBundle {
  seq = 0;
  const brief = node("problem_brief", 1, { id: "brief" });
  const cons = node("solution_constraints", 2, { id: "cons" });
  const approach = node("chosen_approach", 3, { id: "approach" });
  const design = node("design_artifact", 4, { id: "design", mediaType: "text/markdown" });
  const pkgYou = node("audience_package", 5, { id: "pkg-you", variant: "You" });
  const pkgTim = node("audience_package", 5, { id: "pkg-tim", variant: "Tim Burke" });
  const prd = node("product_requirements", 6, { id: "prd" });
  const plan = node("build_plan", 6, { id: "plan" });
  const oldPlan = node("build_plan", 6, { id: "plan-old", supersededByNodeId: "plan" });
  const cost = node("cost_approval", 7, { id: "cost" });
  const material = node("source_material", 1, { id: "pdf", mediaType: "application/pdf" });
  return {
    format: "solutions-builder.project",
    version: 2,
    exportedAt: at,
    project: { id: "old", title: "Agentic Agency", policy: { audiences: [{ name: "You", role: "project_owner" }, { name: "Tim Burke", role: "budget_approver" }], audienceQuorum: 2 } },
    artifacts: [brief, cons, approach, design, pkgYou, pkgTim, prd, plan, oldPlan, cost, material].map((n) => ({ node: n, content: n.id === "prd" ? PRD : `content of ${n.id}` })),
    conversations: [{ stage: 8, messages: [{ id: "m", author: "me", body: "Start", at }] }],
    notes: "workflow events are not included yet",
    ...over,
  };
}
const ids = (b: ProjectBundle) => new Map(b.artifacts.map(({ node }) => [node.id, `new-${node.id}`]));
const digests = (b: ProjectBundle) => new Map(b.artifacts.map(({ node }) => [node.id, `sha-${node.id}`]));

// #652: an import lands where the export was.
describe("a v2 bundle, from its heads", () => {
  test("the furthest material is the stage; every earlier head is approved; the stakeholders are taken as proceed", () => {
    const b = bundle();
    expect(derivedStage(b)).toBe(8);
    const { position, notes } = bundlePosition(b, digests(b));
    expect(position.stage).toBe(8);
    expect(Object.keys(position.approvals).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(position.approvals[6]!.map((v) => v.versionId).sort()).toEqual(["plan", "prd"]);
    expect(position.approvals[5]!.map((v) => v.versionId).sort()).toEqual(["pkg-tim", "pkg-you"]);
    expect(position.audienceVotes).toMatchObject({ You: { decision: "proceed" }, "Tim Burke": { decision: "proceed" } });
    expect(notes.join(" ")).toContain("taken as proceed");
  });

  test("the plan replays through Build plan on the new ids, at version 1 with the written digest, and mints the requirements", () => {
    const b = bundle();
    const plan = bundleAdoptionPlan(b, "proj_new", ids(b), digests(b));
    expect(plan.steps.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.steps[0]!.ref).toEqual({ artifactId: "new-brief", version: 1, sha256: "sha-brief" });
    expect(plan.steps[3]!.ref).toEqual({ artifactId: "new-design", version: 1, sha256: "sha-design" });
    const five = plan.steps[4]!;
    expect(five.policy).toEqual({ quorum: 2, stakeholders: ["You", "Tim Burke"] });
    expect(five.packages).toEqual({ You: { artifactId: "new-pkg-you", version: 1, sha256: "sha-pkg-you" }, "Tim Burke": { artifactId: "new-pkg-tim", version: 1, sha256: "sha-pkg-tim" } });
    expect(Object.keys(five.votes ?? {}).sort()).toEqual(["Tim Burke", "You"]);
    const six = plan.steps[5]!;
    expect(six.ref.artifactId).toBe("new-plan");
    expect(six.requirementItems?.map((i) => i.kind)).toEqual(["FR", "AC"]);
    expect(plan.notes.join(" ")).toContain("Cost approval");
  });

  test("a stage with no document stops the plan before it and says so", () => {
    const b = bundle();
    b.artifacts = b.artifacts.filter(({ node }) => node.kind !== "chosen_approach");
    const plan = bundleAdoptionPlan(b, "p", ids(b), digests(b));
    expect(plan.steps.map((s) => s.stage)).toEqual([1, 2]);
    expect(plan.notes.join(" ")).toContain("Solution proposal has no document in the export");
  });
});

describe("a v3 bundle, from its workflow", () => {
  test("approvals and votes come from the decisions, a send-back withdraws what it reopened, and the stage is the workflow's", () => {
    const b = bundle({
      version: 3,
      workflow: {
        stage: 3,
        done: false,
        decisions: [
          { kind: "approve", stage: 1, artifactId: "a-brief", version: 1, sha256: "x" },
          { kind: "approve", stage: 2, artifactId: "a-cons", version: 1, sha256: "x" },
          { kind: "approve", stage: 3, artifactId: "a-approach", version: 1, sha256: "x" },
          { kind: "send_back", stage: 4, targetStage: 3 },
        ],
        audienceDecisions: {},
        freeze: null,
      },
    });
    const { position } = bundlePosition(b, digests(b));
    expect(position.stage).toBe(3);
    expect(Object.keys(position.approvals).map(Number)).toEqual([1, 2]);
    const plan = bundleAdoptionPlan(b, "p", ids(b), digests(b));
    expect(plan.steps.map((s) => s.stage)).toEqual([1, 2]);
    expect(plan.steps[1]!.ref).toEqual({ artifactId: "new-cons", version: 1, sha256: "sha-cons" });
  });

  test("real votes ride along, and Concept approval names every stakeholder's package", () => {
    const b = bundle({
      version: 3,
      workflow: {
        stage: 7,
        done: false,
        decisions: [1, 2, 3, 4].map((stage) => ({ kind: "approve", stage, artifactId: ["a-brief", "a-cons", "a-approach", "a-design"][stage - 1]!, version: 1 })).concat([
          { kind: "approve", stage: 5, artifactId: "a-pkg-you", version: 1 },
          { kind: "approve", stage: 6, artifactId: "a-plan", version: 1 },
        ]),
        audienceDecisions: { You: { decision: "proceed" }, "Tim Burke": { decision: "revise", note: "Cheaper" } },
        freeze: null,
      },
    });
    const plan = bundleAdoptionPlan(b, "p", ids(b), digests(b));
    const five = plan.steps.find((s) => s.stage === 5)!;
    expect(five.votes).toEqual({ You: { decision: "proceed", note: "" }, "Tim Burke": { decision: "revise", note: "Cheaper" } });
    expect(Object.keys(five.packages ?? {}).sort()).toEqual(["Tim Burke", "You"]);
    expect(plan.notes.join(" ")).not.toContain("taken as proceed");
  });
});
