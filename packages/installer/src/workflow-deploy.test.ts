import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import type { ClosureManifest } from "./registry-tarballs.js";
import { packTarballFiles, tarballFilename } from "./tarball-pack.js";
import { renderLifecycleSource, type ClosureSource } from "./workflow-deploy.js";

/**
 * A synthetic closure fixture, built through the same `packTarballFiles`
 * packer `scripts/closure-pack.ts` uses -- these tests exercise the real
 * fetch-and-extract path `renderLifecycleSource` drives at deploy time,
 * without needing the full vendor tree built.
 */
async function fakeClosure(): Promise<ClosureSource> {
  const packages: { name: string; version: string; files: Record<string, string> }[] = [
    {
      name: "@intx/workflow",
      version: "0.0.0",
      files: { "package.json": '{"name":"@intx/workflow","version":"0.0.0"}\n', "dist/index.js": "export const w = 1;\n" },
    },
    {
      name: "@solutions-builder/app",
      version: "0.1.0",
      files: {
        "package.json": '{"name":"@solutions-builder/app","version":"0.1.0"}\n',
        "src/admit.ts": "export async function admitGate() {}\n",
        "src/guard.ts": "export function evaluate() {}\n",
        "src/project-state.ts": "export function projectState() {}\n",
      },
    },
    {
      name: "@solutions-builder/tools-deck",
      version: "0.1.0",
      files: { "package.json": '{"name":"@solutions-builder/tools-deck","version":"0.1.0"}\n' },
    },
    {
      name: "@solutions-builder/tools-delivery",
      version: "0.1.0",
      files: { "package.json": '{"name":"@solutions-builder/tools-delivery","version":"0.1.0"}\n' },
    },
  ];

  const byFilename = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const manifestPackages = [];
  for (const pkg of packages) {
    const encoded: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(pkg.files)) encoded[path] = encoder.encode(content);
    const bytes = await packTarballFiles(encoded);
    const filename = tarballFilename(pkg.name, pkg.version);
    byFilename.set(filename, bytes);
    manifestPackages.push({ name: pkg.name, version: pkg.version, filename, sha256: "" });
  }
  const manifest: ClosureManifest = { digest: "test", packages: manifestPackages, catalog: { arktype: "^2.0.0" } };
  return {
    manifest,
    fetchTarball: async (filename) => {
      const bytes = byFilename.get(filename);
      if (bytes === undefined) throw new Error(`no packed entry for ${filename}`);
      return bytes;
    },
  };
}

describe("renderLifecycleSource admit gate", () => {
  test("declares interchange.actions admitGate and gateRefused in loops", async () => {
    const files = await renderLifecycleSource(await fakeClosure());
    const member = JSON.parse(files["packages/lifecycle/package.json"]!) as {
      interchange: { actions?: string; loops?: string };
    };
    expect(member.interchange.actions).toBe("./actions.js");
    expect(member.interchange.loops).toBe("./loops.js");
    expect(files["packages/lifecycle/actions.js"]).toContain("admitGate");
    expect(files["packages/lifecycle/actions.js"]).toContain("@solutions-builder/app/admit");
    const loops = files["packages/lifecycle/loops.js"]!;
    expect(loops).toContain("export function gateRefused");
    expect(loops).toContain("export function carryGate");
    expect(loops).toContain("admit.refused === true");
    expect(loops).toContain('["evidence"]');
  });

  test("stillOpen reads the evidence command, not the round start_attempt", async () => {
    const files = await renderLifecycleSource(await fakeClosure());
    const loops = files["packages/lifecycle/loops.js"]!;
    // Bun does not evaluate `data:text/javascript` as ESM (named exports vanish),
    // so the generated loops module is loaded from a file the way the sidecar would.
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-loops-"));
    const path = join(dir, "loops.js");
    await writeFile(path, loops);
    try {
      const mod = (await import(pathToFileURL(path).href)) as {
        stillOpen: (output: Record<string, unknown>) => boolean;
        carryRound: (output: Record<string, unknown>, carry: unknown) => unknown;
      };
      const start = { round: { command: "build.start_attempt" } };
      expect(mod.stillOpen(start)).toBe(true);
      expect(mod.stillOpen({ ...start, evidence: { command: "build.fail" } })).toBe(true);
      expect(mod.stillOpen({ ...start, evidence: { command: "build.accept_evidence" } })).toBe(false);
      const carried = { command: "build.accept_evidence" };
      expect(mod.carryRound({ ...start, evidence: carried }, start.round)).toEqual(carried);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("closes the app member for admit, guard, and project-state", async () => {
    const files = await renderLifecycleSource(await fakeClosure());
    expect(files["packages/solutions-builder-app/src/admit.ts"]).toContain("export async function admitGate");
    expect(files["packages/solutions-builder-app/src/guard.ts"]).toContain("export function evaluate");
    expect(files["packages/solutions-builder-app/src/project-state.ts"]).toContain("export function projectState");
  });
});
