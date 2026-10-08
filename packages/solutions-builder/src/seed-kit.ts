/**
 * The curated kit, as the versioned records §8 asks for.
 *
 * Generated from `AGENT_KIT` rather than written beside it, for the reason the
 * ledger is generated: two lists of the same thing drift, and the one nobody
 * runs is the one that goes stale. The prompts, skills, directors and model
 * bindings here are what the agents in that file already are — named,
 * versioned and readable from outside this process.
 *
 * A skill's `tools` names only tools a specialist carrying it is actually
 * deployed with (`specialist-source.ts`): a tool listed here that no
 * specialist has would be a control that looks real and is not.
 */
import { skillCatalog, skillsFor } from "@solutions-builder/specialist-shared/skill-text";
import type { AgentSeed, CuratedModelBinding, DirectorRecord, KitSeed, PromptRecord, SkillRecord } from "./kit.js";
import { AGENT_KIT, type AgentRole } from "./kit.js";

export { SPECIALIST_TOOLS, skillTextFor } from "@solutions-builder/specialist-shared/skill-text";

/** §8's stable grouping, by the keys it names. */
const DIRECTORS: readonly DirectorRecord[] = [
  {
    key: "sb-facilitator",
    title: "Facilitator",
    agents: ["product-guide", "constraints-mapper", "brief-evaluator"],
  },
  {
    key: "sb-specialists",
    title: "Specialists",
    agents: [
      "brainstormer",
      "proposer",
      "experience-designer",
      "presentation-creator",
      "requirements-author",
      "architect",
      "estimator",
      "delivery-verifier",
      "senior-engineer-application",
      "senior-engineer-quality",
      "senior-engineer-platform",
      "senior-engineer-security",
    ],
  },
  {
    key: "sb-supervisor",
    title: "Builder",
    agents: ["build-supervisor"],
  },
];

function directorFor(role: AgentRole): string {
  const director = DIRECTORS.find((entry) => entry.agents.includes(role.id));
  return director?.key ?? "sb-specialists";
}

/** The whole kit, derived from the roles that already exist. */
export function kitSeed(): KitSeed {
  const prompts: PromptRecord[] = AGENT_KIT.map((role) => ({
    key: role.promptKey,
    version: 1,
    role: role.id,
    system: role.system,
    inputs: ["approved artifact versions", "the conversation so far", "policy"],
    produces: role.produces ?? "verdict",
  }));

  const models: CuratedModelBinding[] = AGENT_KIT.map((role) => ({
    key: role.modelKey ?? `sb-model-${role.id}`,
    // A purpose, never a vendor model id: switching providers is a binding
    // change, not an edit to ten prompts.
    purpose: role.mission,
    temperature: role.temperature,
    fallbackKey: null,
  }));

  const skills: SkillRecord[] = [...skillCatalog()];

  const agents: AgentSeed[] = AGENT_KIT.map((role) => {
    const skillKeys = skillsFor(role);
    const toolKeys = [
      ...new Set(
        skillKeys.flatMap(
          (key) => skills.find((skill) => skill.key === key)?.tools ?? [],
        ),
      ),
    ];
    return {
      key: `sb-agent-${role.id}`,
      agent: role.id,
      promptKey: role.promptKey,
      skillKeys,
      toolKeys,
      directorKey: directorFor(role),
      modelKey: role.modelKey ?? `sb-model-${role.id}`,
      panelKey: role.id.startsWith("senior-engineer-") ? "sb-engineering-panel" : null,
    };
  });

  return { prompts, skills, directors: DIRECTORS, models, agents };
}
