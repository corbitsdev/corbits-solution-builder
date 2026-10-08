/**
 * The skills a role carries, rendered into its own system prompt. This is how
 * a skill's instructions reach the model: a workflow step's agent is defined
 * once at pack time from a static `systemPrompt` string, so there is no
 * per-turn seam that could load a skill later.
 */
import { PLATFORM_SKILLS } from "./platform-skills.ts";

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

export type SkillCatalogRecord = {
  readonly key: string;
  readonly version: number;
  readonly instructions: string;
  readonly description?: string;
  readonly tools: readonly string[];
};

/** The versioned skill records the kit seed publishes, and `skillTextFor` renders. */
export function skillCatalog(): readonly SkillCatalogRecord[] {
  return [
    ...SKILLS.map((skill) => ({
      key: skill.id,
      version: 1,
      instructions: skill.instructions,
      tools: skill.tools,
    })),
    ...PLATFORM_SKILLS.map((skill) => ({
      key: skill.key,
      version: 1,
      instructions: skill.body,
      description: skill.description,
      tools: skill.tools,
    })),
    ...["application", "quality", "platform", "security"].map((specialty) => ({
      key: `${specialty}-review`,
      version: 1,
      instructions: `Review the ${specialty} of a plan against its approved inputs. Require a revision; never grant, waive or approve.`,
      tools: [],
    })),
  ];
}

/** Which skills a role carries. Read off the stages it serves. */
export function skillsFor(role: { readonly id: string }): string[] {
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

export function skillTextFor(role: { readonly id: string }): string {
  const skills = skillCatalog();
  const lines = skillsFor(role)
    .map((key) => skills.find((skill) => skill.key === key))
    .filter((skill): skill is SkillCatalogRecord => skill !== undefined)
    .map((skill) => `- ${skill.key}: ${skill.instructions}`);
  return ["## Skills you carry", ...lines].join("\n");
}
