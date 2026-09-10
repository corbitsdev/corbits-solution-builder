/** The documents the nine stages produce, and which stage owns which. */
export const ARTIFACT_KINDS = [
  "problem_brief",
  "solution_constraints",
  "chosen_approach",
  "design_artifact",
  "design_feedback",
  "audience_package",
  "build_plan",
  "engineering_review",
  "cost_approval",
  "build_packet",
  "build_evidence",
  "delivery_manifest",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Which stage owns which artifact kind. Used to reject cross-stage writes. */
export const ARTIFACT_STAGE: Readonly<Record<ArtifactKind, number>> = {
  problem_brief: 1,
  solution_constraints: 2,
  chosen_approach: 3,
  design_artifact: 4,
  design_feedback: 4,
  audience_package: 5,
  build_plan: 6,
  engineering_review: 6,
  cost_approval: 7,
  build_packet: 7,
  build_evidence: 8,
  delivery_manifest: 9,
};

