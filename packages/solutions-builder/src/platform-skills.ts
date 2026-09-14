/**
 * The five platform skills, one Markdown document each.
 *
 * The same records serve two consumers: the kit bakes a skill's body into
 * the system prompt of every role that carries it (the plan phase), and the
 * hub writes each as `.agents/skills/<key>/SKILL.md` into a build workspace,
 * where the worker's own `skill_search`/`use_skill` tools find them (the
 * exec phase). One source, or the two drift.
 *
 * The bodies say only what the vendored tree and this repository's own
 * dependencies can vouch for: a package named here resolves, a mechanism
 * named here exists.
 */
import whatIsInterchange from "./platform-skills/what-is-interchange.md" with { type: "text" };
import whatIsCorbitsCore from "./platform-skills/what-is-corbitscore.md" with { type: "text" };
import usingInterchange from "./platform-skills/using-interchange.md" with { type: "text" };
import usingCorbitsCore from "./platform-skills/using-corbitscore.md" with { type: "text" };
import designingOnCorbitsCore from "./platform-skills/designing-on-corbitscore.md" with { type: "text" };

export type PlatformSkill = {
  /** The skill's name: its `.agents/skills/` directory and its frontmatter `name`. */
  readonly key: string;
  /** The one line `skill_search` matches against. */
  readonly description: string;
  /** The document body — the kit's `instructions`, the SKILL.md's content. */
  readonly body: string;
  /** The kit tools a carrying role gains; knowledge skills need to read inputs only. */
  readonly tools: readonly string[];
};

export const PLATFORM_SKILLS: readonly PlatformSkill[] = [
  {
    key: "what-is-interchange",
    description: "What Interchange is: the hub, tenants, principals and grants, workflows and runs, agents deployed as workflow definitions, sidecars, assets, credentials.",
    body: whatIsInterchange,
    tools: ["artifact-read"],
  },
  {
    key: "what-is-corbitscore",
    description: "What CorbitsCore is: the corbitsdev package catalog — the reuse surface a deliverable on Interchange draws its parts from.",
    body: whatIsCorbitsCore,
    tools: ["artifact-read"],
  },
  {
    key: "using-interchange",
    description: "How to get and use the @intx/* packages — npm tags versus vendoring faremeter/interchange — and the workflow authoring surface, with an example.",
    body: usingInterchange,
    tools: ["artifact-read", "plan-validate"],
  },
  {
    key: "using-corbitscore",
    description: "How to install the @corbits/* packages — git dependencies, not npm — and how the unpublished workbench packages are vendored.",
    body: usingCorbitsCore,
    tools: ["artifact-read"],
  },
  {
    key: "designing-on-corbitscore",
    description: "How to shape a deliverable on the platform: the three shapes, agents as workflows, skills tools and directors as assets, apps as clients of the hub.",
    body: designingOnCorbitsCore,
    tools: ["artifact-read", "plan-validate"],
  },
];

/** One skill as its SKILL.md: frontmatter the hub's skill schema accepts, then the body. */
export function platformSkillMarkdown(skill: PlatformSkill): string {
  return [
    "---",
    `name: ${skill.key}`,
    `description: ${JSON.stringify(skill.description)}`,
    "version: 1",
    "---",
    "",
    skill.body,
  ].join("\n");
}
