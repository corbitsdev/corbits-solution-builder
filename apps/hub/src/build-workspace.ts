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

## Verifying your work

\`bun test\` runs the test suite — Bun's test runner is built in, so this
works with nothing installed. \`bun run typecheck\` runs the TypeScript
compiler against the seeded \`tsconfig.json\`. Use these; do not reach for
\`npm\`, \`yarn\` or \`npx\`.

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
The \`@intx/workflow\`, \`@intx/agent\` and \`@intx/tools-posix\`
dependencies are already in the root \`package.json\`. Where the registry
is reachable the seed installs them, and then
\`import { defineAgent } from "@intx/agent"\`
typechecks on arrival. The \`vendor/interchange\` and \`vendor/workbench\`
globs are already in \`workspaces\` too, so a vendored platform tree
resolves the moment it lands (the offline fallback).

Commit as you go if this directory is a git repository — each attempt's
work is reviewed against the last.
`;

/** A filesystem-safe name for the seeded package. */
function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "build";
}

/**
 * A tsconfig for a Bun TypeScript project. No `types` entry: that would need
 * `bun-types` installed before it resolves, and the point of this file is to
 * work the moment it lands. `types/` carries one ambient stub so `include`
 * always matches at least one file — an empty match is `tsc`'s own hard
 * error (TS18003), which would fail typecheck before any code exists.
 */
const TSCONFIG = {
  compilerOptions: {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    moduleDetection: "force",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
  },
  include: ["apps", "packages", "types"],
  exclude: ["node_modules", "vendor"],
};

/** The lone file under `types/`, so `tsconfig.json`'s `include` never matches zero files. */
const TYPES_STUB = "export {};\n";

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

  /**
   * The platform packages a worker builds on, resolved from the npm
   * registry — the preferred path (a): the seeded manifest names them, so
   * `bun install` in a fresh workspace fetches them without further steps.
   * Verified with `bun add @intx/workflow@0.3.0 @intx/agent
   * @intx/tools-posix` from a fresh seed (`@intx/workflow` 0.3.0 on the
   * `latest` tag per `platform-skills/using-interchange.md`; `@intx/agent`
   * and `@intx/tools-posix` 0.3.0 verified against the live registry),
   * then `bun install` exiting 0.
   * The `vendor/*` globs below stay: they are the fallback path (b) — only if
   * the registry is blocked, plant the host's `vendor/interchange` and
   * `vendor/workbench` trees plus their VENDORED_REVISION pins, and the same
   * `@intx/*` names resolve as workspace members instead.
   */
  const PLATFORM_DEPENDENCIES: Readonly<Record<string, string>> = {
    "@intx/workflow": "0.3.0",
    "@intx/agent": "0.3.0",
    "@intx/tools-posix": "0.3.0",
  };

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
        dependencies: { ...PLATFORM_DEPENDENCIES },
        // Both need nothing beyond this file: `test` needs no install at
        // all (Bun's test runner is built in), and `typecheck` needs only
        // the `typescript` devDependency below plus the seeded tsconfig.
        scripts: {
          test: "bun test",
          typecheck: "tsc --noEmit",
        },
        devDependencies: {
          typescript: "^5.9.3",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(dir, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
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
  await mkdir(join(dir, "types"), { recursive: true });
  await writeFile(join(dir, "types", "global.d.ts"), TYPES_STUB);

  // Installed now, so `typecheck` works on the worker's first turn rather
  // than after a failed one. `test` needs none of this — it is proven
  // working either way. An install that cannot run (no network, no
  // registry) is reported, not swallowed, and leaves everything seeded
  // above untouched and usable.
  try {
    const install = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "ignore", stderr: "pipe" });
    if (!install.success) {
      console.error(`build-workspace: toolchain install failed for ${dir}: ${install.stderr.toString().trim()}`);
    }
  } catch (err) {
    console.error(`build-workspace: failed to run the toolchain install for ${dir}:`, err);
  }

  // A repository from the start, so the worker's commits — and the diff a
  // continued attempt begins from — have a baseline. The identity is given
  // per command rather than read from host config, which a machine may not
  // have set. Best effort: a host without git still gets a working
  // workspace.
  try {
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (!init.success) {
      console.error(`build-workspace: git init failed for ${dir}: ${init.stderr.toString().trim()}`);
      return;
    }
    const add = Bun.spawnSync(["git", "add", "-A"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (!add.success) {
      console.error(`build-workspace: git add failed for ${dir}: ${add.stderr.toString().trim()}`);
      return;
    }
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
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
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
