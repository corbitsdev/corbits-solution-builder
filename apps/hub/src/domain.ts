/**
 * Boundary contracts — BUILD_PLAN_V3 section 6.
 *
 * ArkType validates external input once, at the boundary that owns it. Nothing
 * below the host route layer re-validates the same constraint; nothing above it
 * trusts an unvalidated shape.
 */
import { type } from "arktype";
import { ARTIFACT_KINDS } from "@solutions-builder/app/artifacts";
import { AUTHORITIES, COMMANDS, STAGES } from "@solutions-builder/app/ledger";

const id = type("string > 0");
const iso = type("string.date.iso");

export const Authority = type.enumerated(...AUTHORITIES);
export const CommandType = type.enumerated(...COMMANDS);
export const StageT = type.enumerated(...STAGES);

/** Every command arrives inside this envelope. Section 6, "Command envelope". */
export const CommandEnvelope = type({
  schemaVersion: "'1'",
  commandId: id,
  type: CommandType,
  actor: {
    id,
    /** Roles the actor holds in this workspace; authority is derived, never sent. */
    roles: Authority.array().atLeastLength(1),
  },
  scope: { workspaceId: id, "projectId?": id },
  correlationId: id,
  idempotencyKey: id,
  "payload?": "unknown",
});
export type CommandEnvelope = typeof CommandEnvelope.infer;

/**
 * Approvals name exact versions. This type exists so no route can accept an
 * approval that merely names an artifact — the whole point of the gate is that
 * the approver and the record agree on which bytes were reviewed.
 */
export const ExactVersionRef = type({
  artifactId: id,
  versionId: id,
  /** SHA-256 of the reviewed bytes; the guard compares it to the stored row. */
  contentHash: "string == 64",
});
export type ExactVersionRef = typeof ExactVersionRef.infer;

export const ProjectOpenPayload = type({
  /**
   * What they typed when they opened the project. Recorded on the
   * `project.create` command itself so stage 1 already knows the problem.
   */
  "problemStatement?": "string <= 4000",
});
export type ProjectOpenPayload = typeof ProjectOpenPayload.infer;

/** Adds credentials to a workbench's consented set after creation. */
export const DelegationUpdatePayload = type({
  credentialIds: type("string > 0").array(),
});
export type DelegationUpdatePayload = typeof DelegationUpdatePayload.infer;

export const BuildFreezePayload = type({
  runId: id,
  /** Every input the packet freezes, by exact version. */
  versions: ExactVersionRef.array().atLeastLength(1),
  placement: "'local' | 'container' | 'target_native'",
  targets: type("string > 0").array(),
});

export const BuildAnswerPayload = type({
  runId: id,
  questionId: id,
  answer: type("string > 0").to("string <= 8000"),
  "grantedCapabilities?": type("string > 0").array(),
});

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

export const ProviderConnectRequest = type({
  kind: "'api_key' | 'local_endpoint' | 'oauth'",
  providerId: type("string > 0").to("string <= 64"),
  label: type("string > 0").to("string <= 120"),
  /**
   * Present only for `api_key`. The host writes it to secure storage and drops
   * it; no route ever reads it back, and it never reaches a response body.
   */
  "secret?": "string > 0",
  /** Present only for `local_endpoint`: the base URL of whatever server is running. */
  "baseUrl?": "string.url",
});
export type ProviderConnectRequest = typeof ProviderConnectRequest.infer;

export { id as IdSchema, iso as IsoDateSchema };

/**
 * What the Product guide returns — BUILD_PLAN_V3 section 8.
 *
 * Orientation, never authority. The guide reads the project and says where it
 * stands, what is missing and what the human could do next; it recommends a
 * route and takes none. Every claim cites the approved versions it was read
 * from, so guidance can be checked against the record rather than trusted.
 */
export const GuidanceRecord = type({
  /** Where the project stands, in a sentence or two. */
  summary: type("string > 0").to("string <= 1200"),
  /** Whether this stage looks ready for its gate. */
  readiness: "'ready' | 'not_ready' | 'blocked'",
  /** Evidence the gate needs that is not there yet. */
  missing: type("string <= 400").array().to("Array <= 10"),
  /** What the human could do, each a real option at this moment. */
  options: type({
    label: type("string > 0").to("string <= 120"),
    detail: type("string <= 400"),
  }).array().to("Array <= 5"),
  /** The recommended one. Always one of `options`, never acted on. */
  recommended: type("string > 0").to("string <= 120"),
  /** Questions worth answering before the next draft. */
  questions: type("string <= 400").array().to("Array <= 8"),
  /** Exact artifact version ids this guidance was read from. */
  sourceVersionIds: id.array().to("Array <= 50"),
  /**
   * Whether a specialist produced this or it is the deterministic checklist.
   * Section 8 requires the fallback; a person is told which one they are
   * reading rather than being left to assume.
   */
  origin: "'agent' | 'deterministic'",
});
export type GuidanceRecord = typeof GuidanceRecord.infer;
