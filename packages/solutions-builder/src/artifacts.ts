/**
 * The kind a person's own uploaded file is recorded under. Named because two
 * places key off it — the hub writes it, `stage-prompt.ts` labels it
 * differently from an artifact the product wrote — and a second spelling of
 * the string is a silent mislabel rather than a type error.
 */
export const MATERIAL_KIND = "source_material";

/**
 * The kind the extracted text of one attached file is recorded under — a
 * companion artifact beside the file's own `source_material` version, never
 * an attachment in its own right.
 */
export const MATERIAL_READING_KIND = "material_reading";

/**
 * The kind a deck design document is recorded under: design guidelines as
 * text or Markdown, or an existing presentation as PowerPoint or PDF, that
 * every stakeholder deck is drafted and drawn against. Kept on the
 * workspace tenant for every project, or on one project's own tenant for
 * that project alone; it carries no `projectId`, because the tenant scopes
 * it and it is a setting, not a stage's work product.
 */
export const DECK_DESIGN_DOCUMENT_KIND = "deck_design_document";

/**
 * The extracted text of a binary deck design document (PDF or PowerPoint),
 * a companion beside the file the way `material_reading` sits beside
 * `source_material`. A text document needs none: its content is the text.
 */
export const DECK_DESIGN_READING_KIND = "deck_design_reading";

/** The kinds stage 8's `publish_workspace` writes, spelled once in the
 *  runtime package that tool ships with (#42) and read here beside every
 *  other kind. */
export { BUILD_EVIDENCE_KIND, DELIVERY_MANIFEST_KIND } from "@solutions-builder/specialist-runtime/artifact-kinds";

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
