/**
 * Boundary contracts — BUILD_PLAN_V3 section 6.
 *
 * ArkType validates external input once, at the boundary that owns it. Nothing
 * below the host route layer re-validates the same constraint; nothing above it
 * trusts an unvalidated shape.
 */
import { type } from "arktype";
import { ARTIFACT_KINDS } from "@solutions-builder/app/artifacts";

const id = type("string > 0");

export const ProjectOpenPayload = type({
  /**
   * What they typed when they opened the project. Recorded on the
   * `project.create` command itself so stage 1 already knows the problem.
   */
  "problemStatement?": "string <= 4000",
});
export type ProjectOpenPayload = typeof ProjectOpenPayload.infer;

export { ARTIFACT_KINDS, ARTIFACT_STAGE, type ArtifactKind } from "@solutions-builder/app/artifacts";
export const ArtifactKindT = type.enumerated(...ARTIFACT_KINDS);

export const ArtifactDraft = type({
  projectId: id,
  kind: ArtifactKindT,
  /**
   * Distinguishes parallel artifacts of the same kind on one branch — stage 5
   * produces one package per audience, and without this they would supersede
   * each other instead of standing side by side.
   */
  "variant?": type("string > 0").to("string <= 120"),
  title: type("string > 0").to("string <= 200"),
  /** Rendered bytes as text; binary lives in a sink, never in a workflow row. */
  content: "string",
  /** A document's type, or a file's: a spreadsheet or an image the person attached keeps its own. */
  mediaType: /^[a-z]+\/[a-z0-9.+-]+$/,
  /** Exact versions this draft was generated from. Empty only at a graph root. */
  sourceVersionIds: id.array(),
  provenance: {
    producer: "'human' | 'agent'",
    "agentRole?": "string > 0",
    "providerId?": "string > 0",
    "model?": "string > 0",
    "runId?": id,
    /** The exact prompt and model binding the specialist ran under. */
    "promptKey?": "string > 0",
    "promptVersion?": "number",
    "modelKey?": "string > 0",
    /** Stated by the agent, lifted from the draft's own headings. */
    "assumptions?": "string[]",
    "questions?": "string[]",
    /** `<childRunId>/<stepId>` of the agent step that produced this version. */
    "stepRef?": "string > 0",
    /** The standing brief this version was drafted against, when compacted. */
    "brief?": "string",
  },
});
export type ArtifactDraft = typeof ArtifactDraft.infer;
