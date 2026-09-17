/**
 * The vendored `@intx/*` packages a deployed workflow imports, shipped inside
 * the workflow asset as workspace members.
 *
 * A code-sourced workflow package resolves its dependencies through the hub's
 * closure resolver: workspace members from the asset tree, everything else
 * from npm. The published `@intx/workflow` predates the loop signal relay the
 * lifecycle relies on, so the deployed package must see the vendored revision.
 * Carrying that revision's `dist/` as members of the asset is the one path
 * that needs no registry plumbing: the resolver already walks members, and the
 * sidecar lays a member out from the same git pack the workflow itself arrives
 * in. The cost is a copy of about a megabyte per lifecycle asset.
 *
 * The bytes come from `workflow-closure-embed.ts`, generated at build time
 * from vendor/ and the tools packages. `install()` must not read the live
 * trees: apps/web imports this package, and the web bundle has no node:fs.
 */
import { createHash } from "node:crypto";
import { WORKFLOW_CLOSURE_EMBED } from "./workflow-closure-embed.js";

/** Where a vendored package lands inside the asset: `packages/intx-<name>`. */
export function memberDir(shortName: string): string {
  return `packages/intx-${shortName}`;
}

type PackageManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  exports?: unknown;
  type?: string;
  [key: string]: unknown;
};

function embedFile(path: string): string {
  const content = WORKFLOW_CLOSURE_EMBED[path];
  if (content === undefined) {
    throw new Error(`workflow-closure embed is missing ${path}; run \`bun scripts/embed-workflow-closure.ts\``);
  }
  return content;
}

function embedUnder(prefix: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(WORKFLOW_CLOSURE_EMBED)) {
    if (path.startsWith(prefix)) files[path.slice(prefix.length)] = content;
  }
  return files;
}

/** A vendored package's own `package.json`, parsed. Exported so callers that
 *  need more than the trimmed shape `memberFiles` produces — the registry-asset
 *  packer reads real `dependencies`/`peerDependencies` off it — read the same
 *  file through the same path rather than a second copy of this join. */
export function readManifest(shortName: string): PackageManifest {
  return JSON.parse(embedFile(`vendor/interchange/packages/${shortName}/package.json`)) as PackageManifest;
}

/** The transitive `workspace:*` closure of `@intx/<root>`, root first. */
export function vendoredClosure(root: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const shortName = queue.shift()!;
    if (seen.has(shortName)) continue;
    seen.add(shortName);
    order.push(shortName);
    const manifest = readManifest(shortName);
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec === "workspace:*" && name.startsWith("@intx/")) queue.push(name.slice("@intx/".length));
    }
  }
  return order;
}

/**
 * The root `catalog` a member's `catalog:` specifier expands against. Taken
 * from this repository's own catalog, which mirrors the vendored revision's.
 */
export function workspaceCatalog(): Record<string, string> {
  const root = JSON.parse(embedFile("package.json")) as { catalog?: Record<string, string> };
  return root.catalog ?? {};
}

/**
 * A vendored package's runtime `dist/` files, keyed by their path relative to
 * `dist/` (POSIX separators). Declarations, source maps and tests are left
 * out; the sidecar evaluates, it does not type-check.
 */
export function distFiles(shortName: string): Record<string, string> {
  const files = embedUnder(`vendor/interchange/packages/${shortName}/dist/`);
  if (Object.keys(files).length === 0) {
    throw new Error(
      `@intx/${shortName} has no dist/; run \`bun run vendor:build\` then \`bun scripts/embed-workflow-closure.ts\` before deploying a code-sourced workflow`,
    );
  }
  return files;
}

/**
 * The member's files: a trimmed manifest (no scripts, dev dependencies or
 * publish metadata; the `intx-src` condition stays and is simply never
 * selected) and every runtime file under `dist/`.
 */
export function memberFiles(shortName: string): Record<string, string> {
  const manifest = readManifest(shortName);
  const trimmed: PackageManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    ...(manifest.dependencies !== undefined ? { dependencies: manifest.dependencies } : {}),
    ...(manifest.peerDependencies !== undefined ? { peerDependencies: manifest.peerDependencies } : {}),
    ...(manifest.peerDependenciesMeta !== undefined
      ? { peerDependenciesMeta: manifest.peerDependenciesMeta }
      : {}),
  };
  const dir = memberDir(shortName);
  const files: Record<string, string> = {
    [`${dir}/package.json`]: `${JSON.stringify(trimmed, null, 2)}\n`,
  };
  for (const [rel, content] of Object.entries(distFiles(shortName))) {
    files[`${dir}/dist/${rel}`] = content;
  }
  return files;
}

/** Every vendored member the lifecycle needs, keyed by asset path. */
export function closureFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const shortName of vendoredClosure(root)) Object.assign(files, memberFiles(shortName));
  return files;
}

/**
 * `@solutions-builder/app`'s modules the deployed lifecycle actually runs:
 * deck/delivery for the tools, and admit/guard/project-state (plus the
 * files they import) so the gate loop's `admitGate` action resolves in the
 * sidecar. Only these ride along. Unlike the vendored `@intx/*` members,
 * this ships as TypeScript source: the package is consumed as source
 * everywhere in this repo (see `scripts/pack-registry-asset.ts`'s
 * `appTarballFiles`), so there is no `dist/` to copy.
 */
export function deckAppMemberFiles(): Record<string, string> {
  const dir = "packages/solutions-builder-app";
  const manifest = {
    name: "@solutions-builder/app",
    version: "0.1.0",
    type: "module",
    exports: { "./*": "./src/*.ts" },
    dependencies: {
      pptxgenjs: "4",
      arktype: "catalog:",
      "@intx/workflow": "workspace:*",
      "@intx/types": "workspace:*",
    },
  };
  return {
    [`${dir}/package.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
    [`${dir}/src/deck.ts`]: embedFile("packages/solutions-builder/src/deck.ts"),
    [`${dir}/src/delivery.ts`]: embedFile("packages/solutions-builder/src/delivery.ts"),
    [`${dir}/src/admit.ts`]: embedFile("packages/solutions-builder/src/admit.ts"),
    [`${dir}/src/guard.ts`]: embedFile("packages/solutions-builder/src/guard.ts"),
    [`${dir}/src/project-state.ts`]: embedFile("packages/solutions-builder/src/project-state.ts"),
    [`${dir}/src/ledger.ts`]: embedFile("packages/solutions-builder/src/ledger.ts"),
    [`${dir}/src/kit.ts`]: embedFile("packages/solutions-builder/src/kit.ts"),
    [`${dir}/src/artifacts.ts`]: embedFile("packages/solutions-builder/src/artifacts.ts"),
    [`${dir}/src/requirements-example.ts`]: embedFile("packages/solutions-builder/src/requirements-example.ts"),
    [`${dir}/src/workflows/stage-loop.ts`]: embedFile("packages/solutions-builder/src/workflows/stage-loop.ts"),
  };
}

/**
 * `@solutions-builder/tools-deck`'s own files: the package stage 5's
 * specialist imports for `render_deck`. Shipped as source for the same
 * reason `deckAppMemberFiles` is: this family of packages has no build
 * step. Its own `package.json` rides along unmodified — its
 * `@solutions-builder/app: workspace:*` dependency resolves against the
 * member `deckAppMemberFiles` ships beside it, and `pptxgenjs` resolves
 * from npm like `hono` already does for the lifecycle package itself.
 */
function toolsMemberFiles(name: string): Record<string, string> {
  const dir = `packages/${name}`;
  const manifest = JSON.parse(embedFile(`packages/${name}/package.json`)) as PackageManifest;
  const trimmed: PackageManifest = {
    name: manifest.name,
    version: manifest.version,
    type: manifest.type ?? "module",
    ...(manifest.exports !== undefined ? { exports: manifest.exports } : {}),
    ...(manifest.dependencies !== undefined ? { dependencies: manifest.dependencies } : {}),
  };
  const files: Record<string, string> = { [`${dir}/package.json`]: `${JSON.stringify(trimmed, null, 2)}\n` };
  const src = embedUnder(`packages/${name}/`);
  for (const [rel, content] of Object.entries(src)) {
    if (rel === "package.json" || /\.test\.tsx?$/.test(rel)) continue;
    files[`${dir}/${rel}`] = content;
  }
  return files;
}

export function toolsDeckMemberFiles(): Record<string, string> {
  return toolsMemberFiles("tools-deck");
}

/**
 * `@solutions-builder/tools-delivery`'s own files: the package a stage 9
 * decision-queue step imports for `delivery_status`, shipped the same way
 * `toolsDeckMemberFiles` ships `tools-deck` — as source, its own
 * `package.json` unmodified, `@solutions-builder/app` resolving against the
 * member `deckAppMemberFiles`-style copy shipped beside it.
 */
export function toolsDeliveryMemberFiles(): Record<string, string> {
  return toolsMemberFiles("tools-delivery");
}

/** One hash over every file, so a changed byte anywhere re-deploys. */
export function treeDigest(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(files[path]!);
    hash.update("\0");
  }
  return hash.digest("hex");
}
