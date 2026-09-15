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
  "product_requirements",
  "build_plan",
  "engineering_review",
  "cost_approval",
  "build_packet",
  "build_evidence",
  "build_review",
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
  /** What stages 1 to 4 agreed, gathered into the one document the plan is written against. */
  product_requirements: 6,
  build_plan: 6,
  engineering_review: 6,
  cost_approval: 7,
  build_packet: 7,
  build_evidence: 8,
  /** Stage 8's panel review — of the evidence, not the plan. `engineering_review` is stage 6's, fixed there; a kind maps to one stage only, so the panel's second review gets its own. */
  build_review: 8,
  delivery_manifest: 9,
  delivery_verification: 9,
};

