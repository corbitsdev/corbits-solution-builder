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

export const ProjectCreatePayload = type({
  /**
   * Optional: the host names a project from the problem it was opened with.
   * A caller may still choose the name, but nobody has to invent one, and the
   * first line of what somebody typed is not a title.
   */
  "title?": type("string <= 200"),
  "problemStatement?": "string <= 4000",
  policy: {
    /** Cost tolerance as a percentage and an absolute figure; both apply. */
    costTolerancePercent: "number >= 0",
    costToleranceAbsolute: "number >= 0",
    /** Named audiences for stage 5, with the quorum fixed before review. */
    audiences: type({ name: "string > 0", role: Authority }).array(),
    audienceQuorum: "number >= 0",
    /** Providers may receive project content only when this permits it. */
    allowExternalProviders: "boolean",
  },
});
export type ProjectCreatePayload = typeof ProjectCreatePayload.infer;

export const StageApprovePayload = type({
  runId: id,
  versions: ExactVersionRef.array().atLeastLength(1),
  "rationale?": "string <= 4000",
});

/**
 * The one-action approval: `stage.submit` immediately followed by whichever
 * command actually leaves `waiting_approval` (`stage.approve` for stages
 * 1-6, `cost.approve` at stage 7). `forecastUsd`/`assumptions` only matter
 * when the resolved stage is 7; optional here because the route does not
 * know the stage until it has read the run.
 */
export const SoloDecidePayload = type({
  runId: id,
  versions: ExactVersionRef.array().atLeastLength(1),
  "rationale?": "string <= 4000",
  "forecastUsd?": "number >= 0",
  "assumptions?": type("string > 0").array(),
});

export const AudienceDecidePayload = type({
  runId: id,
  audienceName: "string > 0",
  decision: "'proceed' | 'reject' | 'revise'",
  versions: ExactVersionRef.array().atLeastLength(1),
  "rationale?": "string <= 4000",
});

export const CostApprovePayload = type({
  runId: id,
  versions: ExactVersionRef.array().atLeastLength(1),
  forecastUsd: "number >= 0",
  assumptions: type("string > 0").array(),
  "rationale?": "string <= 4000",
});

export const BuildFreezePayload = type({
  runId: id,
  /** Every input the packet freezes, by exact version. */
  versions: ExactVersionRef.array().atLeastLength(1),
  placement: "'local' | 'container' | 'target_native'",
  targets: type("string > 0").array(),
});

export const RoutePayload = type({
  runId: id,
  targetStage: StageT,
  reason: type("string > 0").to("string <= 4000"),
});

export const BuildAnswerPayload = type({
  runId: id,
  questionId: id,
  answer: type("string > 0").to("string <= 8000"),
  "grantedCapabilities?": type("string > 0").array(),
});

export const DeliveryDecisionPayload = type({
  runId: id,
  manifestVersion: ExactVersionRef,
  "rationale?": "string <= 4000",
  "targetStage?": StageT,
});

export { ARTIFACT_KINDS, ARTIFACT_STAGE, type ArtifactKind } from "@solutions-builder/app/artifacts";
export const ArtifactKindT = type.enumerated(...ARTIFACT_KINDS);

export const ArtifactDraft = type({
  projectId: id,
  branchId: id,
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
  mediaType: "'text/markdown' | 'text/html' | 'application/json'",
  /** Exact versions this draft was generated from. Empty only at a graph root. */
  sourceVersionIds: id.array(),
  provenance: {
    producer: "'human' | 'agent'",
    "agentRole?": "string > 0",
    "providerId?": "string > 0",
    "model?": "string > 0",
    "runId?": id,
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
  /** Present only for `local_endpoint`, e.g. an Ollama base URL. */
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
