/**
 * The curated agent kit — BUILD_PLAN_V3 section 8.
 *
 * Eleven domain roles. Each resolves its mission, its required approved inputs,
 * the artifact kind it produces and the shared prompt rules every role obeys.
 *
 * The authority line is the important one and it is the same for all of them:
 * a role drafts. Boundary validation and persistence create the artifact, and a
 * human crosses the gate. No profile here carries approval authority, and none
 * can widen a grant or spend.
 *
 * Each role lives in its own `packages/specialist-*` package with its own
 * prompt; this file assembles them and keeps the kit's public surface.
 */
import { PANEL_ROLES } from "@solutions-builder/specialist-plan-review";
import { architect, requirementsAuthor } from "@solutions-builder/specialist-architect";
import { brainstormer } from "@solutions-builder/specialist-brainstormer";
import { briefEvaluator } from "@solutions-builder/specialist-brief-evaluator";
import { approachEvaluator } from "@solutions-builder/specialist-approach-evaluator";
import { constraintsEvaluator } from "@solutions-builder/specialist-constraints-evaluator";
import { designEvaluator } from "@solutions-builder/specialist-design-evaluator";
import { estimateEvaluator } from "@solutions-builder/specialist-estimate-evaluator";
import { planEvaluator } from "@solutions-builder/specialist-plan-evaluator";
import { namer } from "@solutions-builder/specialist-companions";
import { productGuide } from "@solutions-builder/specialist-product-guide";
import { constraintsMapper } from "@solutions-builder/specialist-constraints-mapper";
import { deliveryVerifier } from "@solutions-builder/specialist-delivery-verifier";
import { buildSupervisor } from "@solutions-builder/specialist-build-supervisor";
import { estimator } from "@solutions-builder/specialist-estimator";
import { experienceDesigner } from "@solutions-builder/specialist-experience-designer";
import { presentationCreator } from "@solutions-builder/specialist-presentation-creator";
import { proposer } from "@solutions-builder/specialist-proposer";
import type { AgentRole as SharedAgentRole } from "@solutions-builder/specialist-shared";
import { ARTIFACT_KINDS, type ArtifactKind } from "./artifacts.js";
import type { Stage } from "./ledger.js";

export {
  AGENT_ECONOMICS,
  ARTIFACT_WRITE_RULE,
  ATTACHED_DOCUMENTS_RULE,
  PLATFORM_RULES,
  SHARED_RULES,
} from "@solutions-builder/specialist-shared";

export type AgentRole = SharedAgentRole & { readonly produces: ArtifactKind | null };

/** The specialist packages sit below this one, so they name an artifact kind
 *  as a string; the kit is where it is checked against the real kinds. */
function kind(entry: SharedAgentRole): AgentRole {
  if (entry.produces !== null && !(ARTIFACT_KINDS as readonly string[]).includes(entry.produces)) {
    throw new Error(`${entry.id} produces an unknown artifact kind: ${entry.produces}.`);
  }
  return entry as AgentRole;
}

export const AGENT_KIT: readonly AgentRole[] = [
  brainstormer,
  constraintsMapper,
  proposer,
  experienceDesigner,
  presentationCreator,
  requirementsAuthor,
  architect,
  ...PANEL_ROLES,
  estimator,
  buildSupervisor,
  deliveryVerifier,
  productGuide,
  namer,
  briefEvaluator,
  constraintsEvaluator,
  approachEvaluator,
  designEvaluator,
  planEvaluator,
  estimateEvaluator,
].map(kind);

export function agentFor(stage: Stage): AgentRole {
  const byStage: Partial<Record<Stage, string>> = {
    1: "brainstormer",
    2: "constraints-mapper",
    3: "proposer",
    4: "experience-designer",
    5: "presentation-creator",
    6: "architect",
    7: "estimator",
    8: "build-supervisor",
    9: "delivery-verifier",
  };
  const id = byStage[stage];
  const found = AGENT_KIT.find((entry) => entry.id === id);
  if (!found) throw new Error(`No agent seeded for stage ${stage}.`);
  return found;
}

/** The four panel principals, each reviewed and recorded independently. */
export function panelPrincipals(): AgentRole[] {
  return PANEL_ROLES.map((entry) => {
    const found = AGENT_KIT.find((candidate) => candidate.id === entry.id);
    if (!found) throw new Error(`Panel principal ${entry.id} is missing from the kit.`);
    return found;
  });
}

/** A seeded role by id, for the roles that are not bound to a stage. */
export function agentById(id: string): AgentRole | undefined {
  return AGENT_KIT.find((entry) => entry.id === id);
}

/** The advisory evaluator that reads a stage's drafts, by stage. Stage 6's
 *  reads the Architect's plan, the stage's own draft. */
const EVALUATOR_BY_STAGE: Partial<Record<Stage, string>> = {
  1: "brief-evaluator",
  2: "constraints-evaluator",
  3: "approach-evaluator",
  4: "design-evaluator",
  6: "plan-evaluator",
  7: "estimate-evaluator",
};

/** The stage's draft evaluator, or null for a stage no evaluator reads. */
export function evaluatorFor(stage: Stage): AgentRole | null {
  const id = EVALUATOR_BY_STAGE[stage];
  if (!id) return null;
  const found = agentById(id);
  if (!found) throw new Error(`Evaluator ${id} for stage ${stage} is missing from the kit.`);
  return found;
}

// ---------------------------------------------------------------------------
// The seed records these roles become.


/** Stable seed keys, in the form §8 fixes: `sb-prompt-<role>-v1`. */
export type PromptRecord = {
  readonly key: string;
  readonly version: number;
  readonly role: string;
  readonly system: string;
  /** What the role is handed, and what it must return. */
  readonly inputs: readonly string[];
  readonly produces: string;
};

export type SkillRecord = {
  readonly key: string;
  readonly version: number;
  readonly instructions: string;
  /**
   * The one line a SKILL.md's frontmatter carries and `skill_search` matches
   * against. Absent, the frontmatter falls back to a truncated instructions
   * body — which is why a skill whose body runs long or names `<placeholders>`
   * must set it: the platform's schema forbids angle brackets there.
   */
  readonly description?: string;
  /** The tools, by the names the model calls, that the tool-bearing
   *  deployment of a role carrying this skill is deployed with
   *  (`SPECIALIST_TOOLS` in `seed-kit.ts`). A skill does not grant them;
   *  stage 5's primary deployment, for one, carries no deck tool. */
  readonly tools: readonly string[];
};

/** A named group of agents: what an agent seed's `directorKey` names. The
 *  lifecycle-era workflow ids a director once listed went with the
 *  lifecycle (#39); nothing reads a director's workflows. */
export type DirectorRecord = {
  readonly key: string;
  readonly title: string;
  readonly agents: readonly string[];
};

/** A purpose, bound to a catalogue entry — never to a vendor model id. */
export type CuratedModelBinding = {
  readonly key: string;
  readonly purpose: string;
  readonly temperature: number;
  /** Named explicitly, because §8 requires fallback to be a decision. */
  readonly fallbackKey: string | null;
};

export type AgentSeed = {
  readonly key: string;
  readonly agent: string;
  readonly promptKey: string;
  readonly skillKeys: readonly string[];
  readonly toolKeys: readonly string[];
  readonly directorKey: string;
  readonly modelKey: string;
  /** Set for the four senior-engineer principals, empty for everyone else. */
  readonly panelKey: string | null;
};

/** Everything a seed run writes, in one shape so it can be hashed and diffed. */
export type KitSeed = {
  readonly prompts: readonly PromptRecord[];
  readonly skills: readonly SkillRecord[];
  readonly directors: readonly DirectorRecord[];
  readonly models: readonly CuratedModelBinding[];
  readonly agents: readonly AgentSeed[];
};
