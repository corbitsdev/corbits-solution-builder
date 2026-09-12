/** The documents the nine stages produce, and which stage owns which. */
export const ARTIFACT_KINDS = [
  "source_material",
  "problem_brief",
  "solution_constraints",
  "chosen_approach",
  "design_artifact",
  "design_feedback",
  "audience_package",
  "audience_deck",
  "build_plan",
  "engineering_review",
  "cost_approval",
  "build_packet",
  "build_evidence",
  "delivery_manifest",
  "delivery_verification",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Which stage owns which artifact kind. Used to reject cross-stage writes. */
export const ARTIFACT_STAGE: Readonly<Record<ArtifactKind, number>> = {
  /** What the person handed over with the problem; read by every stage, owned by none. */
  source_material: 1,
  problem_brief: 1,
  solution_constraints: 2,
  chosen_approach: 3,
  design_artifact: 4,
  design_feedback: 4,
  audience_package: 5,
  /** The slides built from a package's deck outline: one per stakeholder, beside the package. */
  audience_deck: 5,
  build_plan: 6,
  engineering_review: 6,
  cost_approval: 7,
  build_packet: 7,
  build_evidence: 8,
  delivery_manifest: 9,
  delivery_verification: 9,
};

