/**
 * The platform skills a build workspace is seeded with.
 *
 * A stage-8 worker arrives able to code but knowing nothing of the
 * platform the plan assumes. These five are the vocabulary it needs —
 * what Interchange and CorbitsCore are, how to get their packages, and how
 * a deliverable is shaped on them — written to `.corbits/skills/` beside
 * the plan so the worker reads them like any other file. Each is the hub's
 * own skill shape (a directory named for the skill holding a SKILL.md),
 * kept out of the evidence archive with the rest of `.corbits`.
 *
 * The bodies are Markdown files beside this module, imported as text so
 * they ship inside a compiled host. They say only what the vendored tree
 * and this repository's own dependencies can vouch for: a package named
 * here resolves, a mechanism named here exists.
 */
import whatIsInterchange from "./build-skills/what-is-interchange.md" with { type: "text" };
import whatIsCorbitsCore from "./build-skills/what-is-corbitscore.md" with { type: "text" };
import usingInterchange from "./build-skills/using-interchange.md" with { type: "text" };
import usingCorbitsCore from "./build-skills/using-corbitscore.md" with { type: "text" };
import designingOnCorbitsCore from "./build-skills/designing-on-corbitscore.md" with { type: "text" };

export type BuildSkill = {
  /** The directory the skill lands in under `.corbits/skills/`; also its frontmatter name. */
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

export const BUILD_SKILLS: readonly BuildSkill[] = [
  {
    name: "what-is-interchange",
    description:
      "What Interchange is: the hub, tenants, principals and grants, workflows and runs, agents deployed as workflow definitions, sidecars, assets and credentials.",
    body: whatIsInterchange,
  },
  {
    name: "what-is-corbitscore",
    description:
      "What CorbitsCore is: the corbitsdev package catalog that is the reuse surface a deliverable on Interchange draws its parts from.",
    body: whatIsCorbitsCore,
  },
  {
    name: "using-interchange",
    description:
      "How to get and use the @intx/* packages — npm tags versus vendoring — and the surfaces a deliverable builds against, from defineWorkflow to a hub deploy.",
    body: usingInterchange,
  },
  {
    name: "using-corbitscore",
    description:
      "How to install the @corbits/* packages — git dependencies, not npm — and what each one replaces in a deliverable.",
    body: usingCorbitsCore,
  },
  {
    name: "designing-on-corbitscore",
    description:
      "How to shape a deliverable on the platform: the three shapes, agents as workflows, skills tools and directors as assets, and apps as clients of the hub.",
    body: designingOnCorbitsCore,
  },
];

/** One skill as its workspace file: frontmatter the hub's skill schema accepts, then the body. */
export function buildSkillMarkdown(skill: BuildSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description)}`,
    "version: 1",
    "---",
    "",
    skill.body,
  ].join("\n");
}
