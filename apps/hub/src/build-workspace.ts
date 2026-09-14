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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILD_SKILLS, buildSkillMarkdown } from "./build-skills.js";

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

## Read first

The skills under \`.corbits/skills/\` are the vocabulary this workspace
assumes. Read them before building: what Interchange and CorbitsCore are,
how to install their packages, and how a deliverable is shaped on them.

## Layout

\`apps/\` holds runnable entry points, \`packages/\` the libraries they
compose, \`docs/\` the written record. The root is a Bun workspace: a new
member joins by giving it a package.json under one of those directories.

## The platform

The deliverable leans on Interchange and the corbitsdev catalog. Reach for
those primitives — workflows and their runs, agents deployed as workflow
definitions, grants, credentials, tools and skills — before writing a new
one. A component the platform already ships is not code this build has to
write.

### Getting the packages

\`@corbits/*\` packages are not on npm; install them from git. The
repository is the package's own name under corbitsdev:

    bun add github:corbitsdev/corbits-artifacts        # @corbits/artifacts
    bun add github:corbitsdev/corbits-oauth-core       # @corbits/oauth-core
    bun add github:corbitsdev/react-ui                 # @corbits/react-ui
    bun add github:corbitsdev/corbits-xai-provider     # @corbits/xai-provider
    bun add github:corbitsdev/corbits-codex-provider   # @corbits/codex-provider
    bun add github:corbitsdev/corbits-openai-responses # @corbits/openai-responses

\`@intx/*\` packages are on npm (\`bun add @intx/workflow\`); the newest tag
is 0.3.0 and upstream main runs ahead of it. When the plan needs what only
main has, vendor instead:

    git clone https://github.com/faremeter/interchange vendor/interchange
    git -C vendor/interchange rev-parse HEAD > vendor/interchange/VENDORED_REVISION
    bun install

\`vendor/interchange/packages/*\` is already in this workspace's
\`workspaces\`, so the vendored packages resolve as \`@intx/*\` once the tree
is there. A vendored tree is a pinned dependency; the revision file is the
pin. The unpublished provisioning packages (\`@corbits/process-provisioner\`,
\`@corbits/sandbox-sidecar\`, \`@corbits/error-sink\`) live in
github.com/corbitsdev/workbench — vendor it under \`vendor/workbench\` the
same way when the plan needs them; its glob is in \`workspaces\` too.

## Where this is going

- Prefer the platform's workflows, agents, tools and skills for core
  functionality over hand-rolled equivalents.
- Package anything a hub would deploy so a deploy can name its source:
  published to npm, or a git repository a hub asset can check out at a
  pinned commit.

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
  for (const skill of BUILD_SKILLS) {
    const skillDir = join(dir, ".corbits", "skills", skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), buildSkillMarkdown(skill));
  }
  if (!opts.fresh) return;

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
  await writeFile(join(dir, ".gitignore"), "node_modules\ndist\n*.log\n.env\n.env.*\n");
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
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Solutions Builder",
        "-c",
        "user.email=solutions-builder@localhost",
        "commit",
        "-q",
        "-m",
        "chore: seed the workspace",
      ],
      { cwd: dir },
    );
  } catch {
    // The files are the seed; version control is a convenience on top.
  }
}
