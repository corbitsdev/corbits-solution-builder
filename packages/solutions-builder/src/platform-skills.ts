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
import corbitsPackages from "./platform-skills/corbits-packages.md" with { type: "text" };
import usingInterchange from "./platform-skills/using-interchange.md" with { type: "text" };
import usingCorbitsPackages from "./platform-skills/using-corbits-packages.md" with { type: "text" };
import designingOnInterchange from "./platform-skills/designing-on-interchange.md" with { type: "text" };

export type PlatformSkill = {
  /** The skill's name: its `.agents/skills/` directory and its frontmatter `name`. */
  readonly key: string;
  /** The one line `skill_search` matches against. */
  readonly description: string;
  /** The document body — the kit's `instructions`, the SKILL.md's content. */
  readonly body: string;
  /** Tools the carrying role is deployed with. Knowledge skills list none: they are read, not called. */
  readonly tools: readonly string[];
};

export const PLATFORM_SKILLS: readonly PlatformSkill[] = [
  {
    key: "what-is-interchange",
    description: "What Interchange is: the hub, tenants, principals and grants, workflows and runs, agents deployed as workflow definitions, sidecars, assets, credentials.",
    body: whatIsInterchange,
    tools: [],
  },
  {
    key: "corbits-packages",
    description: "Reusable Corbits packages and solutions: the corbitsdev catalog, distinct from the Interchange platform.",
    body: corbitsPackages,
    tools: [],
  },
  {
    key: "using-interchange",
    description: "How to install the @intx/* packages from npm, with a CLI-with-agent example, a workflow definition, and a web app that uses the hub as its API.",
    body: usingInterchange,
    tools: [],
  },
  {
    key: "using-corbits-packages",
    description: "How to install the @corbits/* packages from npm and pin the versions the stage 7 freeze names.",
    body: usingCorbitsPackages,
    tools: [],
  },
  {
    key: "designing-on-interchange",
    description: "The shapes Interchange offers, smallest first: local libraries, durable local, and the hub control plane with sidecar-isolated agents.",
    body: designingOnInterchange,
    tools: [],
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
