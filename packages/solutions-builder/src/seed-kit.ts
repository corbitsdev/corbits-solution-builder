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
import type { AgentSeed, CuratedModelBinding, DirectorRecord, KitSeed, PromptRecord, SkillRecord } from "./kit.js";
import { AGENT_KIT, type AgentRole } from "./kit.js";
import { PLATFORM_SKILLS } from "./platform-skills.js";

/** The tools each tool package gives a specialist, by the names the model
 *  calls. `packages/installer/src/kit-tools.test.ts` checks these against the
 *  packages themselves. */
export const SPECIALIST_TOOLS = {
  deck: ["render_deck"],
  posix: ["read_file", "write_file", "edit_file", "run_shell", "search_files", "grep"],
  publishWorkspace: ["publish_workspace"],
  delivery: ["deliver"],
} as const;

/** §8: "Default skills remain …" — the ten, verbatim. */
const SKILLS: readonly { id: string; instructions: string; tools: readonly string[] }[] = [
  { id: "stage-navigation", instructions: "Say where a project stands and what the next human decision is. Recommend a route; never take one.", tools: [] },
  { id: "discovery-interview", instructions: "Interview a problem rather than a solution. Ask the question whose answer changes the most, one at a time.", tools: [] },
  { id: "constraint-framing", instructions: "Turn answers into bounds: platforms, privacy, integrations, installation and non-goals. Mark what is unknown as unknown.", tools: [] },
  { id: "proposal-comparison", instructions: "Compare at most two approaches on the same criteria. Never select one.", tools: [] },
  { id: "interaction-design", instructions: "Work out surfaces, flows and states, and the criteria a build will be measured against.", tools: [] },
  { id: "approval-packaging", instructions: "Prepare one package per named audience, answering whether this is worth pursuing.", tools: [] },
  { id: "requirements-authoring", instructions: "Gather what the approved stages agreed into one requirements document: every requirement traceable to an input, every acceptance criterion testable. Add nothing the inputs do not support.", tools: [] },
  { id: "build-planning", instructions: "Turn an approved concept into a plan a code builder can execute, with owners and acceptance conditions.", tools: [] },
  { id: "cost-estimation", instructions: "Produce a reproducible estimate from immutable inputs, with assumptions stated. Never spend.", tools: [] },
  { id: "worker-supervision", instructions: "Coordinate a build without writing its code. Humans decide permissions, material changes and evidence.", tools: [] },
  {
    id: "interchange-platform",
    instructions: [
      "Interchange, in the shapes it offers. Local libraries: `@intx/inference`, `@intx/agent` and `@intx/workflow` run in the app's own process, credentials from the app's own config. Durable local: `@intx/workflow-host` adds a run that survives a restart and a human gate that can wait. Control plane: a hub owns tenants, principals, credentials, assets and deployments, and runs agents and workflows in sidecars isolated from each other and from the app, which is the hub's client; a person, a deployed agent or a workflow run acts as a principal, and grants decide what it may do.",
      "An agent is a workflow definition deployed to a hub, or `createAgent` in-process. A workflow is `defineWorkflow` over steps: an agent `step`, a drafting `loop`, a human gate on `awaitSignal`, an `action` naming a handler, plus `map`, `gate`, `childWorkflow`, `sleep`, `onTrigger` and `escalation`.",
      "The `@corbits/*` packages on npm: `@corbits/artifacts` for versioned files, `@corbits/react-ui` for the components a generated interface draws from, `@corbits/oauth-core` for an OAuth flow, the provider and adapter packages for model connectors; the `@intx/tools-*` packages are an agent step's tools. The corbits-packages skill is the full list with versions.",
    ].join(" "),
    tools: [],
  },
  { id: "delivery-verification", instructions: "Verify accessible bytes against the manifest. An unknown is not a pass.", tools: [...SPECIALIST_TOOLS.delivery] },
  { id: "brief-evaluation", instructions: "Judge whether a problem brief is ready for a person to approve. Advisory only: never approves, edits or blocks.", tools: [] },
];

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

/** Which skills a role carries. Read off the stages it serves. */
function skillsFor(role: AgentRole): string[] {
  // The platform reference (the five platform skills, and the
  // `interchange-platform` summary) is carried only by the roles that decide
  // or review the architecture: the Architect in full, the panel reviewers
  // the summary. Every other role is told what the stack is by the stage
  // that decided it, and reads nothing about the platform.
  const platform = PLATFORM_SKILLS.map((skill) => skill.key);
  const byRole: Record<string, string[]> = {
    "product-guide": ["stage-navigation"],
    brainstormer: ["discovery-interview", "proposal-comparison"],
    "constraints-mapper": ["constraint-framing"],
    proposer: ["proposal-comparison"],
    "experience-designer": ["interaction-design"],
    "presentation-creator": ["approval-packaging"],
    "requirements-author": ["requirements-authoring"],
    architect: ["build-planning", "interchange-platform", ...platform],
    estimator: ["cost-estimation"],
    "build-supervisor": ["worker-supervision", "interchange-platform"],
    "delivery-verifier": ["delivery-verification"],
    "brief-evaluator": ["brief-evaluation"],
  };
  if (role.id.startsWith("senior-engineer-")) {
    const specialty = role.id.replace("senior-engineer-", "");
    return ["build-planning", `${specialty}-review`, "interchange-platform"];
  }
  return byRole[role.id] ?? ["stage-navigation"];
}

/**
 * The skills a role carries, rendered into its own system prompt. This is how
 * a skill's instructions reach the model: a workflow step's agent is defined
 * once at render time from a static `systemPrompt` string, so there is no
 * per-turn seam that could load a skill later.
 */
export function skillTextFor(role: AgentRole): string {
  const seed = kitSeed();
  const lines = skillsFor(role)
    .map((key) => seed.skills.find((skill) => skill.key === key))
    .filter((skill): skill is SkillRecord => skill !== undefined)
    .map((skill) => `- ${skill.key}: ${skill.instructions}`);
  return ["## Skills you carry", ...lines].join("\n");
}

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

  const skills: SkillRecord[] = [
    ...SKILLS.map((skill) => ({
      key: skill.id,
      version: 1,
      instructions: skill.instructions,
      tools: skill.tools,
    })),
    // The platform skills are Markdown documents, one file each; their
    // bodies are the instructions here and the SKILL.md content a build
    // workspace's `.agents/skills/` gets.
    ...PLATFORM_SKILLS.map((skill) => ({
      key: skill.key,
      version: 1,
      instructions: skill.body,
      description: skill.description,
      tools: skill.tools,
    })),
    // The panel's four review skills, one per principal.
    ...["application", "quality", "platform", "security"].map((specialty) => ({
      key: `${specialty}-review`,
      version: 1,
      instructions: `Review the ${specialty} of a plan against its approved inputs. Require a revision; never grant, waive or approve.`,
      tools: [],
    })),
  ];

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
