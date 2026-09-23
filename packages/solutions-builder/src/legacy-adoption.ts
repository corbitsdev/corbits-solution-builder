/**
 * Adopting a project made on `main` into the project workflow.
 *
 * On `main` a project's position lived in its ledger: commands recorded as
 * turns on the project's ledger session, each carrying the run's stage
 * before and after, and an approval carrying the exact versions it named.
 * Its documents lived in `builder.artifact_node` rows beside the artifact
 * store, one row per version, with the stage, the kind, the provenance and
 * the versions each draft was generated from.
 *
 * Here a project's position is its own workflow run, and its documents are
 * read off the artifact store's `metadata.sb`. Neither knows the old shape,
 * so a project made on `main` opens on stage 1 with no documents. Adoption
 * folds the old ledger into the decisions the workflow would have recorded
 * (`legacyPosition`, `adoptionPlan`) and the old node rows into the
 * metadata the graph reads (`legacyArtifactMetadata`). Everything here is
 * pure; `scripts/adopt-legacy-projects.ts` reads the old rows, applies the
 * metadata, and replays the decisions through the running workflow, so the
 * workflow's own reducer is what lands the stage, with the ledger to show
 * for it.
 *
 * What is not adopted: stage 7 and beyond. The old ledger never recorded a
 * build target, and stage 7's approval here freezes one the person chose,
 * so a project past stage 6 is landed at stage 7 for the person to approve.
 */
import type { ArtifactGraphMetadata, ArtifactProvenance } from "./artifact-graph.js";
import { versionIdFor } from "./artifact-graph.js";
import { extractRequirementItems } from "./requirements.js";
import type { AudiencePolicy } from "./project-workflow/contracts.js";

/** One ledger command as `main` recorded it on the ledger session, in order. */
export type LegacyCommand = {
  readonly command: string;
  readonly stage?: number;
  readonly decision?: string | null;
  readonly audienceName?: string | null;
  readonly rationale?: string | null;
  readonly versions?: readonly LegacyVersion[];
  readonly after?: { readonly stage?: number; readonly state?: string } | null;
};

/** A version an approval named: the node row, the artifact, and the content's sha256. */
export type LegacyVersion = {
  readonly versionId: string;
  readonly artifactId: string;
  readonly contentHash: string;
};

/** One `builder.artifact_node` row. */
export type LegacyNode = {
  readonly id: string;
  readonly projectId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly kind: string;
  readonly stage: number;
  readonly variant: string | null;
  readonly mediaType: string;
  readonly provenance: Record<string, unknown> | null;
  readonly supersededByNodeId: string | null;
};

export type LegacyEdge = { readonly childNodeId: string; readonly sourceNodeId: string };

export type AudienceVote = { readonly decision: "proceed" | "revise" | "reject"; readonly note: string };

/** Where the old ledger left the project, after every route back is applied. */
export type LegacyPosition = {
  readonly stage: number;
  readonly done: boolean;
  /** The versions the last approval of each stage named, for stages the route backs left approved. */
  readonly approvals: Readonly<Record<number, readonly LegacyVersion[]>>;
  /** Each stakeholder's latest stage 5 vote, by audience name. */
  readonly audienceVotes: Readonly<Record<string, AudienceVote>>;
};

/** The commands that approve a stage's material, by the stage they close. */
const APPROVING_COMMANDS = new Set(["stage.approve", "cost.approve", "delivery.accept"]);
const DONE_STATES = new Set(["delivered"]);

/**
 * Folds the ledger's commands into the position the workflow should be
 * landed on. A route back (any command that leaves the run at an earlier
 * stage than it was) withdraws every approval at or past where it lands,
 * the way the workflow's own `send_back` marks those reviews stale.
 */
export function legacyPosition(commands: readonly LegacyCommand[]): LegacyPosition {
  const approvals: Record<number, readonly LegacyVersion[]> = {};
  const audienceVotes: Record<string, AudienceVote> = {};
  let stage = 1;
  let done = false;
  for (const command of commands) {
    const landed = command.after?.stage ?? command.stage ?? stage;
    if (landed < stage) {
      for (const approved of Object.keys(approvals).map(Number)) if (approved >= landed) delete approvals[approved];
      if (landed <= 5) for (const name of Object.keys(audienceVotes)) delete audienceVotes[name];
    }
    stage = landed;
    done = DONE_STATES.has(command.after?.state ?? "");
    const at = command.stage ?? stage;
    if (APPROVING_COMMANDS.has(command.command) && (command.decision === "approve" || command.decision === "accept" || command.decision == null)) {
      if (command.versions && command.versions.length > 0) approvals[at] = command.versions;
    }
    if (command.command === "audience.decide" && command.audienceName && isVote(command.decision)) {
      audienceVotes[command.audienceName] = { decision: command.decision, note: command.rationale ?? "" };
    }
  }
  return { stage, done, approvals, audienceVotes };
}

function isVote(value: unknown): value is AudienceVote["decision"] {
  return value === "proceed" || value === "revise" || value === "reject";
}

/** A reference the workflow understands: the artifact, its version number, and the content's digest. */
export type AdoptedReference = { readonly artifactId: string; readonly version: number; readonly sha256: string };

/** One stage's replay: what to open and approve, and what that stage needs first. */
export type AdoptionStep = {
  readonly stage: number;
  readonly ref: AdoptedReference;
  /** Stage 5: the quorum policy the review is opened under, and the votes replayed before the approval. */
  readonly policy?: AudiencePolicy;
  readonly votes?: Readonly<Record<string, AudienceVote>>;
  /** Stage 6: the requirement items minted before the plan is approved. */
  readonly requirementItems?: readonly { readonly kind: "FR" | "NFR" | "IR" | "AC"; readonly text: string }[];
};

export type AdoptionPlan = {
  readonly projectId: string;
  /** Where the old ledger left the project. */
  readonly legacyStage: number;
  readonly legacyDone: boolean;
  /** The stages replayed, in order; the workflow lands one past the last of them. */
  readonly steps: readonly AdoptionStep[];
  /** What the replay cannot do, said plainly, so the report names it. */
  readonly notes: readonly string[];
};

/** The document kind each stage's approval names, mirroring the client's `STAGE_DRAFT_KIND`. */
export const LEGACY_STAGE_DRAFT_KIND: Readonly<Record<number, string>> = {
  1: "problem_brief",
  2: "solution_constraints",
  3: "chosen_approach",
  4: "design_artifact",
  5: "audience_package",
  6: "build_plan",
  7: "cost_approval",
  8: "build_evidence",
  9: "delivery_manifest",
};

/** The last stage adoption replays: stage 7 needs a target the old ledger never recorded. */
export const LAST_ADOPTED_STAGE = 6;

/**
 * The replay that lands a project where the old ledger left it, as far as
 * the workflow's own rules can be satisfied from what was recorded.
 *
 * `nodes` are the project's node rows, for the version numbers the
 * references need; `readContent` returns the text of one version, for the
 * requirement items stage 6 mints from the approved requirements document.
 */
export function adoptionPlan(args: {
  readonly projectId: string;
  readonly position: LegacyPosition;
  readonly nodes: readonly LegacyNode[];
  readonly policy: { readonly audiences: readonly { readonly name: string }[]; readonly audienceQuorum: number };
  readonly readContent: (artifactId: string, version: number) => string | null;
}): AdoptionPlan {
  const byNodeId = new Map(args.nodes.map((node) => [node.id, node]));
  const notes: string[] = [];
  const steps: AdoptionStep[] = [];
  const target = Math.min(args.position.stage, LAST_ADOPTED_STAGE + 1);
  if (args.position.stage > LAST_ADOPTED_STAGE + 1 || (args.position.stage === LAST_ADOPTED_STAGE + 1 && args.position.approvals[7])) {
    notes.push(
      `Stage ${String(args.position.stage)} on the old ledger: replayed through stage ${String(LAST_ADOPTED_STAGE)}; stage 7 needs a delivery target, which the old ledger never recorded, so approve it here.`,
    );
  }
  for (let stage = 1; stage < target; stage += 1) {
    const versions = args.position.approvals[stage];
    if (!versions) {
      notes.push(`Stage ${String(stage)} has no approval on the old ledger; replay stops before it.`);
      break;
    }
    const wanted = LEGACY_STAGE_DRAFT_KIND[stage];
    const named = versions
      .map((version) => ({ version, node: byNodeId.get(version.versionId) }))
      .filter((entry): entry is { version: LegacyVersion; node: LegacyNode } => entry.node !== undefined);
    const chosen = named.find((entry) => entry.node.kind === wanted) ?? named[0];
    if (!chosen) {
      notes.push(`Stage ${String(stage)}'s approval names versions with no node rows; replay stops before it.`);
      break;
    }
    const ref: AdoptedReference = { artifactId: chosen.version.artifactId, version: chosen.node.version, sha256: chosen.version.contentHash };
    const step: AdoptionStep = { stage, ref };
    if (stage === 5) {
      const policy: AudiencePolicy = { quorum: args.policy.audienceQuorum, stakeholders: args.policy.audiences.map((audience) => audience.name) };
      steps.push({ ...step, policy, votes: args.position.audienceVotes });
      continue;
    }
    if (stage === 6) {
      const requirements = named.find((entry) => entry.node.kind === "product_requirements");
      const text = requirements ? args.readContent(requirements.version.artifactId, requirements.node.version) : null;
      const items = text ? extractRequirementItems(text) : [];
      if (items.length === 0) notes.push("Stage 6's approved requirements document yielded no requirement items; none were minted.");
      steps.push({ ...step, requirementItems: items });
      continue;
    }
    steps.push(step);
  }
  return { projectId: args.projectId, legacyStage: args.position.stage, legacyDone: args.position.done, steps, notes };
}

/** The `sb` metadata to stamp on one artifact's current version, and which version that is. */
export type AdoptedArtifactMetadata = { readonly artifactId: string; readonly version: number; readonly sb: ArtifactGraphMetadata };

/**
 * The graph metadata each artifact's newest node row describes. The graph
 * keeps one node per artifact and reads the current version's metadata, so
 * the newest row is the one that speaks for the artifact; the exact versions
 * it was generated from become `sourceVersionIds` in the graph's own
 * `artifactId@version` form.
 */
export function legacyArtifactMetadata(nodes: readonly LegacyNode[], edges: readonly LegacyEdge[]): AdoptedArtifactMetadata[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const newest = new Map<string, LegacyNode>();
  for (const node of nodes) {
    const current = newest.get(node.artifactId);
    if (!current || node.version > current.version) newest.set(node.artifactId, node);
  }
  const sourcesOf = new Map<string, string[]>();
  for (const edge of edges) {
    const source = byId.get(edge.sourceNodeId);
    if (!source) continue;
    const list = sourcesOf.get(edge.childNodeId) ?? [];
    list.push(versionIdFor(source.artifactId, source.version));
    sourcesOf.set(edge.childNodeId, list);
  }
  // The graph's `supersedes` points from the newer artifact to the one it
  // replaced; the old rows pointed the other way, from the replaced node to
  // its successor. Only a successor in another artifact is a supersession
  // the graph needs to hear about: a newer version of the same artifact is
  // already that artifact's current version.
  const supersedes = new Map<string, string>();
  for (const node of nodes) {
    const successor = node.supersededByNodeId ? byId.get(node.supersededByNodeId) : undefined;
    if (successor && successor.artifactId !== node.artifactId) supersedes.set(successor.id, node.artifactId);
  }
  return [...newest.values()].map((node) => ({
    artifactId: node.artifactId,
    version: node.version,
    sb: {
      projectId: node.projectId,
      kind: node.kind,
      stage: node.stage,
      ...(node.variant ? { variant: node.variant } : {}),
      ...(supersedes.has(node.id) ? { supersedes: supersedes.get(node.id)! } : {}),
      sourceVersionIds: sourcesOf.get(node.id) ?? [],
      provenance: legacyProvenance(node.provenance),
      mediaType: node.mediaType,
    },
  }));
}

function legacyProvenance(raw: Record<string, unknown> | null): ArtifactProvenance {
  const producer = raw?.producer === "human" ? "human" : "agent";
  const provenance: ArtifactProvenance = { producer };
  for (const key of ["agentRole", "providerId", "model", "runId", "promptKey"] as const) {
    const value = raw?.[key];
    if (typeof value === "string" && value.length > 0) provenance[key] = value;
  }
  return provenance;
}
