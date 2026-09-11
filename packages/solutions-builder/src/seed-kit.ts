/**
 * The curated kit, as the versioned records §8 asks for.
 *
 * Generated from `AGENT_KIT` rather than written beside it, for the reason the
 * ledger is generated: two lists of the same thing drift, and the one nobody
 * runs is the one that goes stale. The prompts, skills, tools, grants,
 * directors and model bindings here are what the agents in that file already
 * are — named, versioned and readable from outside this process.
 *
 * §8's default lists are reproduced exactly: ten skills, the tool categories,
 * and the three stable directors. Where §8 names a key, that key is used.
 */
import type {
  AgentSeed,
  CuratedModelBinding,
  DirectorRecord,
  GrantCapability,
  KitSeed,
  PromptRecord,
  RequiredGrant,
  SkillRecord,
  ToolDeclaration,
} from "./kit.js";
import { AGENT_KIT, type AgentRole } from "./kit.js";
import type { Stage } from "./ledger.js";
import { baseTemplate } from "./template.js";
import {
  APPROVAL_WORKFLOW_ID,
  BUILD_SUPERVISION_WORKFLOW_ID,
  DELIVERY_WORKFLOW_ID,
  DESIGN_FEEDBACK_WORKFLOW_ID,
  PROVIDER_SWITCH_WORKFLOW_ID,
} from "./workflows/concerns.js";
import { PROJECT_LIFECYCLE_ID } from "./workflows/project-lifecycle.js";
import { STAGE_WORKFLOW_ID } from "./workflows/stage-loop.js";

/** §8: "Default skills remain …" — the ten, verbatim. */
const SKILLS: readonly { id: string; instructions: string; tools: readonly string[] }[] = [
  { id: "stage-navigation", instructions: "Say where a project stands and what the next human decision is. Recommend a route; never take one.", tools: ["workflow-read", "artifact-read"] },
  { id: "discovery-interview", instructions: "Interview a problem rather than a solution. Ask the question whose answer changes the most, one at a time.", tools: ["conversation", "artifact-draft"] },
  { id: "constraint-framing", instructions: "Turn answers into bounds: platforms, privacy, integrations, installation and non-goals. Mark what is unknown as unknown.", tools: ["conversation", "artifact-draft"] },
  { id: "proposal-comparison", instructions: "Compare at most two approaches on the same criteria. Never select one.", tools: ["artifact-read", "artifact-draft"] },
  { id: "interaction-design", instructions: "Work out surfaces, flows and states, and the criteria a build will be measured against.", tools: ["artifact-draft", "feedback"] },
  { id: "approval-packaging", instructions: "Prepare one package per named audience, answering whether this is worth pursuing.", tools: ["artifact-draft", "artifact-read"] },
  { id: "build-planning", instructions: "Turn an approved concept into a plan a code builder can execute, with owners and acceptance conditions.", tools: ["artifact-draft", "plan-validate"] },
  { id: "cost-estimation", instructions: "Produce a reproducible estimate from immutable inputs, with assumptions stated. Never spend.", tools: ["policy-cost", "artifact-draft"] },
  { id: "worker-supervision", instructions: "Coordinate a build without writing its code. Humans decide permissions, material changes and evidence.", tools: ["packet-freeze", "mail", "events", "builder-signal-propose"] },
  {
    id: "interchange-platform",
    instructions: [
      "Check what the platform already provides before planning to build it. In this revision that means: workflows and their runs, agents deployed as workflow definitions rather than rows in an agent table, grants as a requirement manifest the hub resolves at launch, credentials as tenant-owned rows whose secret is sealed at rest, mail as sessions and messages, sidecars and their allocation for placement, and tenants, principals and roles for authority.",
      "Name the primitive you are using. A plan that says \"a queue\" where the platform has one is a plan to write a second queue.",
      "Do not model authority twice. Tenant and principal are the platform's; reference them rather than keeping a parallel copy, and let grants resolve against whoever launched the run.",
      "Secrets live in an OS keychain where the machine has one. The hub's credential row holds the sealed key, never plaintext; the sidecar decrypts it to authenticate.",
      "Beyond the runtime, the corbitsdev catalog is the reuse surface. `@corbits/artifacts` is a versioned artifact store — the one Builder itself uses. `@corbits/react-ui` is the UI kit a generated interface should draw its components from. `@corbits/oauth-core` handles an OAuth flow rather than one being written by hand. The `@corbits/*-provider` packages are the connectors to individual services. The `@intx/tools-*` packages are the tool implementations an agent step calls.",
      "A generated solution is normally one of three shapes: a workflow deployment with agent steps, a desktop host embedding the hub, or a hosted hub. Pick the shape the requirement actually needs rather than defaulting to one.",
      "Where the platform genuinely lacks something, say so plainly and scope it as work — a substitute that pretends to be the primitive is worse than an admitted gap.",
    ].join(" "),
    tools: ["artifact-read", "plan-validate"],
  },
  { id: "delivery-verification", instructions: "Verify accessible bytes against the manifest. An unknown is not a pass.", tools: ["sink-checksum", "artifact-draft"] },
  { id: "brief-evaluation", instructions: "Judge whether a problem brief is ready for a person to approve. Advisory only: never approves, edits or blocks.", tools: ["artifact-read"] },
];

/**
 * §8's tool categories, with read, propose and write kept apart.
 *
 * The split is the point: "no agent gets human approval authority from a
 * workflow-write tool", and a single `workflow` tool is how that authority
 * arrives unnoticed.
 */
const TOOLS: readonly ToolDeclaration[] = [
  { key: "artifact-read", source: "builder", mode: "read", grantKey: "grant-artifact-read" },
  { key: "artifact-draft", source: "builder", mode: "propose", grantKey: "grant-artifact-propose" },
  { key: "artifact-write", source: "builder", mode: "write", grantKey: "grant-artifact-write" },
  { key: "conversation", source: "interchange", mode: "propose", grantKey: "grant-conversation" },
  { key: "workflow-read", source: "interchange", mode: "read", grantKey: "grant-workflow-read" },
  { key: "builder-signal-propose", source: "builder", mode: "propose", grantKey: "grant-signal-propose" },
  { key: "plan-validate", source: "builder", mode: "read", grantKey: "grant-plan-validate" },
  { key: "policy-cost", source: "builder", mode: "read", grantKey: "grant-policy-read" },
  { key: "feedback", source: "builder", mode: "propose", grantKey: "grant-feedback-propose" },
  { key: "packet-freeze", source: "builder", mode: "write", grantKey: "grant-packet-freeze" },
  { key: "mail", source: "interchange", mode: "propose", grantKey: "grant-mail" },
  { key: "events", source: "interchange", mode: "read", grantKey: "grant-events-read" },
  { key: "provider-manage", source: "builder", mode: "write", grantKey: "grant-provider-manage" },
  { key: "credential-metadata", source: "builder", mode: "read", grantKey: "grant-credential-metadata" },
  { key: "sink-checksum", source: "builder", mode: "read", grantKey: "grant-sink-verify" },
];

const GRANTS: readonly GrantCapability[] = [
  { key: "grant-artifact-read", capability: "artifact.read", scope: "project", requiresApproval: false },
  { key: "grant-artifact-propose", capability: "artifact.propose", scope: "project", requiresApproval: false },
  // Writing an artifact is what makes a draft real, so it is never granted to
  // a role that also decides anything.
  { key: "grant-artifact-write", capability: "artifact.write", scope: "project", requiresApproval: false },
  { key: "grant-conversation", capability: "conversation.append", scope: "project", requiresApproval: false },
  { key: "grant-workflow-read", capability: "workflow.read", scope: "project", requiresApproval: false },
  { key: "grant-signal-propose", capability: "signal.propose", scope: "project", requiresApproval: true },
  { key: "grant-plan-validate", capability: "plan.validate", scope: "project", requiresApproval: false },
  { key: "grant-policy-read", capability: "policy.read", scope: "project", requiresApproval: false },
  { key: "grant-feedback-propose", capability: "feedback.propose", scope: "project", requiresApproval: false },
  { key: "grant-packet-freeze", capability: "packet.freeze", scope: "project", requiresApproval: true },
  { key: "grant-mail", capability: "mail.send", scope: "project", requiresApproval: false },
  { key: "grant-events-read", capability: "events.read", scope: "project", requiresApproval: false },
  { key: "grant-provider-manage", capability: "provider.manage", scope: "tenant", requiresApproval: true },
  { key: "grant-credential-metadata", capability: "credential.metadata", scope: "tenant", requiresApproval: false },
  { key: "grant-sink-verify", capability: "sink.verify", scope: "project", requiresApproval: false },
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
    title: "Supervisor",
    agents: ["build-supervisor"],
    workflows: [BUILD_SUPERVISION_WORKFLOW_ID],
  },
];

/** Which skills a role carries. Read off the stages it serves. */
function skillsFor(role: AgentRole): string[] {
  const byRole: Record<string, string[]> = {
    "product-guide": ["stage-navigation"],
    brainstormer: ["discovery-interview", "proposal-comparison"],
    "constraints-mapper": ["constraint-framing"],
    proposer: ["proposal-comparison"],
    "experience-designer": ["interaction-design", "interchange-platform"],
    "presentation-creator": ["approval-packaging", "interchange-platform"],
    architect: ["build-planning", "interchange-platform"],
    estimator: ["cost-estimation", "interchange-platform"],
    "build-supervisor": ["worker-supervision", "interchange-platform"],
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

/** Which slot fills which stage, for reading the agent off the template. */
const STAGE_SLOTS: Partial<Record<Stage, string[]>> = {
  1: ["discovery-interviewer"],
  2: ["constraint-mapper"],
  3: ["proposal-strategy"],
  4: ["surface-design", "design-feedback"],
  5: ["audience-package"],
  6: ["plan-and-review"],
  7: ["estimate-and-policy"],
  8: ["build-execution"],
  9: ["target-verification", "delivery-manifest"],
};

/**
 * The grants a stage's agent needs, as Interchange's own requirement manifest.
 *
 * §8's read/propose/write split is expressed here rather than in a Builder
 * table, because this is what the hub resolves at launch into materialized
 * grants — a grant recorded anywhere else is a description of an authority
 * rather than the authority itself.
 *
 * `source: "invoker"` throughout: an agent acts on the authority of whoever
 * launched the run, and is satisfied only if that person actually holds the
 * capability. That is what stops a definition granting itself something its
 * author could not.
 */
export function grantRequirementsFor(stage: Stage): RequiredGrant[] {
  const seed = kitSeed();
  const slotAgent = baseTemplate().slots.find((binding) =>
    STAGE_SLOTS[stage]?.includes(binding.slot),
  )?.agent;
  const agent = seed.agents.find((entry) => entry.agent === slotAgent);
  if (!agent) return [];

  return agent.toolKeys.flatMap((toolKey) => {
    const tool = seed.tools.find((entry) => entry.key === toolKey);
    const grant = seed.grants.find((entry) => entry.key === tool?.grantKey);
    if (!tool || !grant) return [];
    return [
      {
        resource: grant.capability,
        action: tool.mode,
        // A capability whose exercise needs a human decision is asked for,
        // never assumed — §8's "no agent gets human approval authority".
        effect: grant.requiresApproval ? ("ask" as const) : ("allow" as const),
        source: "invoker" as const,
      },
    ];
  });
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
    // The panel's four review skills, one per principal.
    ...["application", "quality", "platform", "security"].map((specialty) => ({
      key: `${specialty}-review`,
      version: 1,
      instructions: `Review the ${specialty} of a plan against its approved inputs. Require a revision; never grant, waive or approve.`,
      tools: ["artifact-read", "plan-validate", "builder-signal-propose"],
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
      grantKeys: toolKeys.map(
        (key) => TOOLS.find((tool) => tool.key === key)?.grantKey ?? "grant-artifact-read",
      ),
      directorKey: directorFor(role),
      modelKey: role.modelKey ?? `sb-model-${role.id}`,
      panelKey: role.id.startsWith("senior-engineer-") ? "sb-engineering-panel" : null,
    };
  });

  return { prompts, skills, tools: TOOLS, grants: GRANTS, directors: DIRECTORS, models, agents };
}
