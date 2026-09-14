/**
 * What a build workspace starts with.
 *
 * The bounded bridge hands the worker a directory and a prompt and nothing
 * else, so the directory itself has to carry what a prompt cannot: the
 * layout the deliverable keeps, where the platform's packages come from,
 * and the plan it is being built against. A worker that found an empty
 * directory reasonably reported the platform packages unavailable — they
 * were — and built substitutes; the seed is what makes the plan's "built on
 * Interchange and CorbitsCore" buildable rather than aspirational.
 *
 * `.corbits/` is rewritten on every attempt, including continued ones: the
 * packet it holds is this attempt's, and a retry after a material change
 * must not build against the old one. Everything else is seeded once, at
 * the clean start, and is the worker's to change from then on.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILD_SKILLS } from "./build-skills.js";

export type WorkspaceSeed = {
  /** The project's own name, for the package manifest and the README. */
  readonly title: string;
  /** The approved build plan, verbatim. */
  readonly plan: string;
  /** The requirements the plan is measured against, verbatim. */
  readonly requirements: string;
};

const AGENTS = `# Working in this repository

This workspace was seeded by Solutions Builder. The approved plan is
\`.corbits/BUILD_PLAN.md\`; the requirements it must satisfy are
\`.corbits/REQUIREMENTS.md\`. They are the contract — build against them.

## The platform

Skills under \`.agents/skills/\` carry the platform vocabulary — what
Interchange and CorbitsCore are, how to install their packages, how a
deliverable is shaped on them. They are agent tooling, not project files;
your skill tools can search and load them.

Reach for the platform's primitives — workflows and their runs, agents
deployed as workflow definitions, grants, credentials, tools and skills —
before writing a new one.

## Layout

\`apps/\` holds runnable entry points, \`packages/\` the libraries they
compose, \`docs/\` the written record. The root is a Bun workspace: a new
member joins by giving it a package.json under one of those directories.
The \`vendor/interchange\` and \`vendor/workbench\` globs are already in
\`workspaces\`, so a vendored platform tree resolves the moment it lands.

Commit as you go if this directory is a git repository — each attempt's
work is reviewed against the last.
`;

/** A filesystem-safe name for the seeded package. */
function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "build";
}

export async function seedBuildWorkspace(
  dir: string,
  seed: WorkspaceSeed,
  opts: { fresh: boolean },
): Promise<void> {
  await mkdir(join(dir, ".corbits"), { recursive: true });
  await writeFile(join(dir, ".corbits", "BUILD_PLAN.md"), seed.plan);
  await writeFile(join(dir, ".corbits", "REQUIREMENTS.md"), seed.requirements);
  // `.agents/skills/` is where the worker's own skill tools look. Reseeded
  // every attempt like the packet: the skills are the bridge's, not the
  // worker's, and an updated host should reach an old workspace.
  for (const skill of BUILD_SKILLS) {
    const skillDir = join(dir, ".agents", "skills", skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skill.markdown);
  }
  if (!opts.fresh) {
    // A workspace continued from an older seed may lack the line; the
    // skills under `.agents/` are the bridge's tooling, never the
    // project's, so the ignore is repaired rather than only seeded.
    const gitignore = join(dir, ".gitignore");
    const existing = await readFile(gitignore, "utf8").catch(() => "");
    if (!existing.split("\n").includes(".agents/")) {
      await writeFile(gitignore, `${existing.trimEnd()}\n.agents/\n`);
    }
    return;
  }

  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: slug(seed.title),
        private: true,
        workspaces: [
          "apps/*",
          "packages/*",
          "vendor/interchange/packages/*",
          "vendor/interchange/apps/*",
          "vendor/workbench/packages/*",
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(dir, "README.md"),
    `# ${seed.title}\n\nBuilt by Solutions Builder. The approved plan is \`.corbits/BUILD_PLAN.md\`, the requirements are \`.corbits/REQUIREMENTS.md\`, and how this repository is put together is \`AGENTS.md\`.\n`,
  );
  await writeFile(join(dir, "AGENTS.md"), AGENTS);
  await writeFile(
    join(dir, ".gitignore"),
    // `.agents` is where the seeded skills sit: tooling for the worker,
    // never part of the project it is building.
    "node_modules\ndist\n*.log\n.env\n.env.*\n.agents/\n",
  );
  for (const member of ["apps", "packages", "docs"]) {
    await mkdir(join(dir, member), { recursive: true });
    await writeFile(join(dir, member, ".gitkeep"), "");
  }

  // A repository from the start, so the worker's commits — and the diff a
  // continued attempt begins from — have a baseline. The identity is given
  // per command rather than read from host config, which a machine may not
  // have set. Best effort: a host without git still gets a working
  // workspace.
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    // This is the app writing a baseline into a scratch workspace, not the
    // operator authoring a commit, so the operator's hooks (an author
    // allowlist, say) and signing requirement must not apply.
    const commit = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Solutions Builder",
        "-c",
        "user.email=solutions-builder@localhost",
        "-c",
        "core.hooksPath=",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "chore: seed the workspace",
      ],
      { cwd: dir },
    );
    if (!commit.success) {
      console.error(
        `build-workspace: baseline commit failed for ${dir}: ${commit.stderr.toString().trim()}`,
      );
    }
  } catch (err) {
    console.error(`build-workspace: failed to seed version control for ${dir}:`, err);
  }
}
