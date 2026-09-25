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
import {
  APPROVAL_WORKFLOW_ID,
  BUILD_SUPERVISION_WORKFLOW_ID,
  DELIVERY_WORKFLOW_ID,
  DESIGN_FEEDBACK_WORKFLOW_ID,
  PROVIDER_SWITCH_WORKFLOW_ID,
} from "./workflows/concerns.js";
import { PROJECT_LIFECYCLE_ID, STAGE_WORKFLOW_ID } from "./workflows/stage-ids.js";

/** The tools each tool package gives a specialist, by the names the model
 *  calls. `packages/installer/src/kit-tools.test.ts` checks these against the
 *  packages themselves. */
export const SPECIALIST_TOOLS = {
  deck: ["render_deck"],
  posix: ["read_file", "write_file", "edit_file", "run_shell", "search_files", "grep"],
  publishWorkspace: ["publish_workspace"],
  delivery: ["delivery_status", "deliver"],
} as const;

/** §8: "Default skills remain …" — the ten, verbatim. */
const SKILLS: readonly { id: string; instructions: string; tools: readonly string[] }[] = [
  { id: "stage-navigation", instructions: "Say where a project stands and what the next human decision is. Recommend a route; never take one.", tools: [] },
  { id: "discovery-interview", instructions: "Interview a problem rather than a solution. Ask the question whose answer changes the most, one at a time.", tools: [] },
  { id: "constraint-framing", instructions: "Turn answers into bounds: platforms, privacy, integrations, installation and non-goals. Mark what is unknown as unknown.", tools: [] },
  { id: "proposal-comparison", instructions: "Compare at most two approaches on the same criteria. Never select one.", tools: [] },
  { id: "interaction-design", instructions: "Work out surfaces, flows and states, and the criteria a build will be measured against.", tools: [] },
  { id: "approval-packaging", instructions: "Prepare one package per named audience, answering whether this is worth pursuing.", tools: [...SPECIALIST_TOOLS.deck] },
  { id: "requirements-authoring", instructions: "Gather what the approved stages agreed into one requirements document: every requirement traceable to an input, every acceptance criterion testable. Add nothing the inputs do not support.", tools: [] },
  { id: "build-planning", instructions: "Turn an approved concept into a plan a code builder can execute, with owners and acceptance conditions.", tools: [] },
  { id: "cost-estimation", instructions: "Produce a reproducible estimate from immutable inputs, with assumptions stated. Never spend.", tools: [] },
  { id: "build-engineering", instructions: "Build the software yourself with the shell tool, in small verified steps: scaffold, install, implement, typecheck, run, fix, report. Every reply carries the real commands run and their real output. Humans decide permissions, material changes and evidence.", tools: [...SPECIALIST_TOOLS.posix, ...SPECIALIST_TOOLS.publishWorkspace] },
  {
    id: "interchange-platform",
    instructions: [
      "Build what the person asked for. Most solutions are ordinary product software — a web app, a CLI, a service — and stay ordinary software on the house stack; this skill is reference for the parts of a solution that are genuinely agentic or that need durable tenancy, not a mandate to reframe the product itself.",
      "Product software still runs on the Interchange hub's database as its control plane: its own tables in their own Postgres schema, foreign-keyed into the hub's `tenant` and `principal` tables for tenancy and users, login through the hub's Better Auth. That is not the same as being a workflow or an agent.",
      "Where a solution genuinely needs an agent, a workflow, an approval gate or mail, here is what the platform already provides: workflows and their runs, agents deployed as workflow definitions rather than rows in an agent table, grants as a requirement manifest the hub resolves at launch, credentials as tenant-owned rows whose secret is sealed at rest, mail as sessions and messages, sidecars and their allocation for placement, and tenants, principals and roles for authority. Name the primitive you are using rather than writing a second one.",
      "Do not model authority twice. Tenant and principal are the platform's; reference them rather than keeping a parallel copy, and let grants resolve against whoever launched the run.",
      "Secrets live in an OS keychain where the machine has one. The hub's credential row holds the sealed key, never plaintext; the sidecar decrypts it to authenticate.",
      "Beyond the runtime, the corbitsdev catalog is the reuse surface for agentic capability. `@corbits/artifacts` is a versioned artifact store — the one Builder itself uses. `@corbits/react-ui` is the UI kit a generated interface should draw its components from, ordinary product screens included. `@corbits/oauth-core` handles an OAuth flow rather than one being written by hand. The `@corbits/*-provider` packages are the connectors to individual services. The `@intx/tools-*` packages are the tool implementations an agent step calls.",
      "A solution that is genuinely agentic is normally one of three shapes: a workflow deployment with agent steps, a desktop host embedding the hub, or a hosted hub. Pick the shape the requirement actually needs rather than defaulting to one, and do not force ordinary product software into any of them.",
      "Where a genuinely agentic need lacks a primitive, say so plainly and scope it as work — a substitute that pretends to be the primitive is worse than an admitted gap.",
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
    workflows: [PROJECT_LIFECYCLE_ID, STAGE_WORKFLOW_ID, APPROVAL_WORKFLOW_ID],
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
    workflows: [
      STAGE_WORKFLOW_ID,
      APPROVAL_WORKFLOW_ID,
      DESIGN_FEEDBACK_WORKFLOW_ID,
      PROVIDER_SWITCH_WORKFLOW_ID,
      DELIVERY_WORKFLOW_ID,
    ],
  },
  {
    key: "sb-supervisor",
    title: "Builder",
    agents: ["build-engineer"],
    workflows: [BUILD_SUPERVISION_WORKFLOW_ID],
  },
];

/** Which skills a role carries. Read off the stages it serves. */
function skillsFor(role: AgentRole): string[] {
  // The platform skills' five keys, spread where a role needs the reference
  // rather than the one-line summary `interchange-platform` gives.
  const platform = PLATFORM_SKILLS.map((skill) => skill.key);
  const byRole: Record<string, string[]> = {
    "product-guide": ["stage-navigation"],
    brainstormer: ["discovery-interview", "proposal-comparison"],
    "constraints-mapper": ["constraint-framing"],
    proposer: ["proposal-comparison"],
    "experience-designer": ["interaction-design", "interchange-platform"],
    "presentation-creator": ["approval-packaging", "interchange-platform"],
    "requirements-author": ["requirements-authoring", "interchange-platform"],
    architect: ["build-planning", "interchange-platform", ...platform],
    estimator: ["cost-estimation", "interchange-platform"],
    "build-engineer": ["build-engineering", "interchange-platform", ...platform],
    "delivery-verifier": ["delivery-verification", "interchange-platform"],
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
