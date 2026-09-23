import { describe, expect, test } from "bun:test";
import { adoptionPlan, legacyArtifactMetadata, legacyPosition, type LegacyCommand, type LegacyNode } from "./legacy-adoption.js";

const version = (versionId: string, artifactId: string, contentHash: string) => ({ versionId, artifactId, contentHash });

/** The shape `main` recorded, trimmed to what the fold reads: Inteva Complete's own ledger, abridged. */
const inteva: LegacyCommand[] = [
  { command: "project.create", stage: 1, after: { stage: 1, state: "in_progress" } },
  { command: "stage.draft", stage: 1, after: { stage: 1, state: "in_progress" } },
  { command: "stage.submit", stage: 1, after: { stage: 1, state: "waiting_approval" } },
  { command: "stage.approve", stage: 1, decision: "approve", versions: [version("nod_brief10", "art_brief", "sha-brief-10")], after: { stage: 2, state: "in_progress" } },
  { command: "stage.approve", stage: 2, decision: "approve", versions: [version("nod_constraints", "art_constraints", "sha-constraints")], after: { stage: 3, state: "in_progress" } },
  { command: "stage.approve", stage: 3, decision: "approve", versions: [version("nod_approach", "art_approach", "sha-approach")], after: { stage: 4, state: "in_progress" } },
  { command: "stage.approve", stage: 4, decision: "approve", versions: [version("nod_design1", "art_design", "sha-design-1")], after: { stage: 5, state: "in_progress" } },
  { command: "stage.submit", stage: 5, after: { stage: 5, state: "waiting_approval" } },
  // Sent back from 5 to 4, then 4 approved again with a new design version.
  { command: "stage.revise", stage: 5, decision: "revise", after: { stage: 5, state: "backtracked" } },
  { command: "stage.select_route", stage: 4, after: { stage: 4, state: "in_progress" } },
  { command: "stage.submit", stage: 4, after: { stage: 4, state: "waiting_approval" } },
  { command: "stage.approve", stage: 4, decision: "approve", versions: [version("nod_design2", "art_design", "sha-design-2")], after: { stage: 5, state: "in_progress" } },
];

const nodes: LegacyNode[] = [
  { id: "nod_brief10", projectId: "p", artifactId: "art_brief", version: 10, kind: "problem_brief", stage: 1, variant: null, mediaType: "text/markdown", provenance: { producer: "agent", agentRole: "brainstormer", runId: "run_x" }, supersededByNodeId: null },
  { id: "nod_brief9", projectId: "p", artifactId: "art_brief", version: 9, kind: "problem_brief", stage: 1, variant: null, mediaType: "text/markdown", provenance: { producer: "agent" }, supersededByNodeId: "nod_brief10" },
  { id: "nod_constraints", projectId: "p", artifactId: "art_constraints", version: 3, kind: "solution_constraints", stage: 2, variant: null, mediaType: "text/markdown", provenance: null, supersededByNodeId: null },
  { id: "nod_approach", projectId: "p", artifactId: "art_approach", version: 2, kind: "chosen_approach", stage: 3, variant: null, mediaType: "text/markdown", provenance: { producer: "agent" }, supersededByNodeId: null },
  { id: "nod_design1", projectId: "p", artifactId: "art_design", version: 1, kind: "design_artifact", stage: 4, variant: null, mediaType: "text/html", provenance: { producer: "agent" }, supersededByNodeId: "nod_design2" },
  { id: "nod_design2", projectId: "p", artifactId: "art_design", version: 2, kind: "design_artifact", stage: 4, variant: null, mediaType: "text/html", provenance: { producer: "agent" }, supersededByNodeId: null },
  { id: "nod_pdf", projectId: "p", artifactId: "art_pdf", version: 1, kind: "source_material", stage: 1, variant: "brief.pdf", mediaType: "application/pdf", provenance: { producer: "human" }, supersededByNodeId: null },
];

describe("legacyPosition", () => {
  test("lands where the last command left the run, with each stage's last approval", () => {
    const position = legacyPosition(inteva);
    expect(position.stage).toBe(5);
    expect(position.done).toBe(false);
    expect(Object.keys(position.approvals).map(Number)).toEqual([1, 2, 3, 4]);
    expect(position.approvals[4]![0]!.versionId).toBe("nod_design2");
  });

  test("a route back withdraws the approvals at and past where it lands", () => {
    const routedBack = [...inteva, { command: "stage.revise", stage: 5, decision: "revise", after: { stage: 5, state: "backtracked" } }, { command: "stage.select_route", stage: 2, after: { stage: 2, state: "in_progress" } }];
    const position = legacyPosition(routedBack);
    expect(position.stage).toBe(2);
    expect(Object.keys(position.approvals).map(Number)).toEqual([1]);
  });

  test("stage 5 keeps each stakeholder's latest vote", () => {
    const voted = [
      ...inteva,
      { command: "audience.decide", stage: 5, decision: "revise", audienceName: "You", rationale: "not yet", after: { stage: 5, state: "waiting_approval" } },
      { command: "audience.decide", stage: 5, decision: "proceed", audienceName: "Finance", rationale: "", after: { stage: 5, state: "waiting_approval" } },
      { command: "audience.decide", stage: 5, decision: "proceed", audienceName: "You", rationale: "fine now", after: { stage: 5, state: "waiting_approval" } },
    ];
    expect(legacyPosition(voted).audienceVotes).toEqual({ You: { decision: "proceed", note: "fine now" }, Finance: { decision: "proceed", note: "" } });
  });

  test("a delivered run is done", () => {
    expect(legacyPosition([{ command: "delivery.accept", stage: 9, decision: "accept", after: { stage: 9, state: "delivered" } }]).done).toBe(true);
  });
});

describe("adoptionPlan", () => {
  const policy = { audiences: [{ name: "You" }, { name: "Finance" }], audienceQuorum: 1 };

  test("replays each approved stage with the version its approval named", () => {
    const plan = adoptionPlan({ projectId: "p", position: legacyPosition(inteva), nodes, policy, readContent: () => null });
    expect(plan.legacyStage).toBe(5);
    expect(plan.steps.map((step) => step.stage)).toEqual([1, 2, 3, 4]);
    expect(plan.steps[0]!.ref).toEqual({ artifactId: "art_brief", version: 10, sha256: "sha-brief-10" });
    expect(plan.steps[3]!.ref).toEqual({ artifactId: "art_design", version: 2, sha256: "sha-design-2" });
    expect(plan.notes).toEqual([]);
  });

  test("stage 5 carries the quorum policy and the votes; stage 6 mints from the requirements document", () => {
    const further: LegacyCommand[] = [
      ...inteva,
      { command: "audience.decide", stage: 5, decision: "proceed", audienceName: "You", rationale: "", after: { stage: 5, state: "waiting_approval" } },
      { command: "stage.approve", stage: 5, decision: "approve", versions: [version("nod_package", "art_package", "sha-package")], after: { stage: 6, state: "in_progress" } },
      { command: "stage.approve", stage: 6, decision: "approve", versions: [version("nod_plan", "art_plan", "sha-plan"), version("nod_reqs", "art_reqs", "sha-reqs")], after: { stage: 7, state: "in_progress" } },
    ];
    const more: LegacyNode[] = [
      ...nodes,
      { id: "nod_package", projectId: "p", artifactId: "art_package", version: 1, kind: "audience_package", stage: 5, variant: "You", mediaType: "text/markdown", provenance: null, supersededByNodeId: null },
      { id: "nod_plan", projectId: "p", artifactId: "art_plan", version: 6, kind: "build_plan", stage: 6, variant: null, mediaType: "text/markdown", provenance: null, supersededByNodeId: null },
      { id: "nod_reqs", projectId: "p", artifactId: "art_reqs", version: 2, kind: "product_requirements", stage: 6, variant: null, mediaType: "text/markdown", provenance: null, supersededByNodeId: null },
    ];
    const plan = adoptionPlan({
      projectId: "p",
      position: legacyPosition(further),
      nodes: more,
      policy,
      readContent: (artifactId, v) => (artifactId === "art_reqs" && v === 2 ? "## Functional requirements\n\n- FR-1 The thing loads.\n\n## Acceptance criteria\n\n- AC-1 It works.\n" : null),
    });
    expect(plan.steps.map((step) => step.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    const five = plan.steps[4]!;
    expect(five.policy).toEqual({ quorum: 1, stakeholders: ["You", "Finance"] });
    expect(five.votes).toEqual({ You: { decision: "proceed", note: "" } });
    const six = plan.steps[5]!;
    expect(six.ref).toEqual({ artifactId: "art_plan", version: 6, sha256: "sha-plan" });
    expect(six.requirementItems?.map((item) => item.kind)).toEqual(["FR", "AC"]);
    // Left at stage 7 on the old ledger, landed at stage 7 here: nothing to note.
    expect(plan.notes).toEqual([]);
  });

  test("a project past stage 6 is landed at stage 7 and told why", () => {
    const built: LegacyCommand[] = [
      ...inteva,
      { command: "stage.approve", stage: 5, decision: "approve", versions: [version("nod_package", "art_package", "sha-package")], after: { stage: 6, state: "in_progress" } },
      { command: "stage.approve", stage: 6, decision: "approve", versions: [version("nod_plan", "art_plan", "sha-plan")], after: { stage: 7, state: "in_progress" } },
      { command: "cost.approve", stage: 7, decision: "approve", versions: [version("nod_cost", "art_cost", "sha-cost")], after: { stage: 8, state: "queued" } },
      { command: "build.start_attempt", stage: 8, after: { stage: 8, state: "running" } },
    ];
    const more: LegacyNode[] = [
      ...nodes,
      { id: "nod_package", projectId: "p", artifactId: "art_package", version: 1, kind: "audience_package", stage: 5, variant: "You", mediaType: "text/markdown", provenance: null, supersededByNodeId: null },
      { id: "nod_plan", projectId: "p", artifactId: "art_plan", version: 6, kind: "build_plan", stage: 6, variant: null, mediaType: "text/markdown", provenance: null, supersededByNodeId: null },
      { id: "nod_cost", projectId: "p", artifactId: "art_cost", version: 15, kind: "cost_approval", stage: 7, variant: null, mediaType: "text/markdown", provenance: null, supersededByNodeId: null },
    ];
    const plan = adoptionPlan({ projectId: "p", position: legacyPosition(built), nodes: more, policy, readContent: () => null });
    expect(plan.legacyStage).toBe(8);
    expect(plan.steps.map((step) => step.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.notes.some((note) => note.includes("stage 7 needs a delivery target"))).toBe(true);
  });

  test("stops before a stage the old ledger never approved", () => {
    const gap = inteva.filter((command) => !(command.command === "stage.approve" && command.stage === 2));
    const plan = adoptionPlan({ projectId: "p", position: legacyPosition(gap), nodes, policy, readContent: () => null });
    expect(plan.steps.map((step) => step.stage)).toEqual([1]);
    expect(plan.notes[0]).toContain("Stage 2 has no approval");
  });
});

describe("legacyArtifactMetadata", () => {
  test("speaks for each artifact through its newest node, with its sources in the graph's form", () => {
    const stamped = legacyArtifactMetadata(nodes, [{ childNodeId: "nod_constraints", sourceNodeId: "nod_brief10" }, { childNodeId: "nod_constraints", sourceNodeId: "nod_pdf" }]);
    const brief = stamped.find((entry) => entry.artifactId === "art_brief")!;
    expect(brief.version).toBe(10);
    expect(brief.sb).toEqual({ projectId: "p", kind: "problem_brief", stage: 1, sourceVersionIds: [], provenance: { producer: "agent", agentRole: "brainstormer", runId: "run_x" }, mediaType: "text/markdown" });
    const constraints = stamped.find((entry) => entry.artifactId === "art_constraints")!;
    expect(constraints.sb.sourceVersionIds).toEqual(["art_brief@10", "art_pdf@1"]);
    expect(constraints.sb.provenance).toEqual({ producer: "agent" });
    const pdf = stamped.find((entry) => entry.artifactId === "art_pdf")!;
    expect(pdf.sb.variant).toBe("brief.pdf");
    expect(pdf.sb.provenance.producer).toBe("human");
    expect(stamped.every((entry) => entry.sb.supersedes === undefined)).toBe(true);
  });

  test("a successor in another artifact is recorded as superseding it", () => {
    const replaced: LegacyNode[] = [
      { id: "n1", projectId: "p", artifactId: "art_a", version: 1, kind: "design_artifact", stage: 4, variant: null, mediaType: "text/html", provenance: null, supersededByNodeId: "n2" },
      { id: "n2", projectId: "p", artifactId: "art_b", version: 1, kind: "design_artifact", stage: 4, variant: null, mediaType: "text/html", provenance: null, supersededByNodeId: null },
    ];
    const stamped = legacyArtifactMetadata(replaced, []);
    expect(stamped.find((entry) => entry.artifactId === "art_b")!.sb.supersedes).toBe("art_a");
  });
});
