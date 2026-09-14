/**
 * The platform skills a build workspace offers the worker.
 *
 * The records live in the kit (`packages/solutions-builder`); this is where
 * each becomes a file the worker's agent can find: `.agents/skills/<name>/
 * SKILL.md`, the location the corbits exec worker's own `skill_search` and
 * `use_skill` tools scan. They are agent tooling, not project files — the
 * seeded `.gitignore` keeps them out of the repository and the archive
 * leaves them out too.
 */
import { PLATFORM_SKILLS, platformSkillMarkdown, type PlatformSkill } from "@solutions-builder/app/platform-skills";

export type BuildSkill = {
  readonly name: string;
  /** The file's content: frontmatter the platform's skill schema accepts, then the body. */
  readonly markdown: string;
};

export const BUILD_SKILLS: readonly BuildSkill[] = PLATFORM_SKILLS.map((skill: PlatformSkill) => ({
  name: skill.key,
  markdown: platformSkillMarkdown(skill),
}));
