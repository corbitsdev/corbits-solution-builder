import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { extractTarballFiles } from "@solutions-builder/installer/tarball-extract";
import {
  buildManifest,
  buildPackedEntries,
  isRegistrySpec,
  isRepoPackageDir,
  manifestEntry,
  rewriteDependencies,
  ROOT_DIR,
  type PackedEntry,
} from "./closure-pack.js";

function entry(name: string, version: string, filename: string, content: string): PackedEntry {
  return { name, version, filename, bytes: new TextEncoder().encode(content) };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("manifestEntry", () => {
  test("carries name, version, filename, and the content's own sha256", () => {
    const packed = entry("@intx/workflow", "0.3.0", "intx-workflow-0.3.0.tgz", "dist bytes");
    expect(manifestEntry(packed)).toEqual({
      name: "@intx/workflow",
      version: "0.3.0",
      filename: "intx-workflow-0.3.0.tgz",
      sha256: sha256("dist bytes"),
    });
  });
});

describe("buildManifest", () => {
  test("rejects conflicting bytes at one package filename", () => {
    expect(() => buildManifest("test", [
      entry("app", "1.0.0", "app-1.0.0.tgz", "curated"),
      entry("app", "1.0.0", "app-1.0.0.tgz", "raw"),
    ])).toThrow("Duplicate closure");
  });

  test("rejects duplicate identities even under distinct filenames", () => {
    expect(() => buildManifest("test", [
      entry("app", "1.0.0", "a.tgz", "first"),
      entry("app", "1.0.0", "b.tgz", "second"),
    ])).toThrow("Duplicate closure");
  });

  test("sorts packages by filename regardless of input order", () => {
    const manifest = buildManifest("test", [
      entry("b", "1.0.0", "b-1.0.0.tgz", "b"),
      entry("a", "1.0.0", "a-1.0.0.tgz", "a"),
    ]);
    expect(manifest.packages.map((pkg) => pkg.filename)).toEqual(["a-1.0.0.tgz", "b-1.0.0.tgz"]);
    expect(manifest.generatedBy).toBe("test");
  });

  test("changing one entry's bytes changes the manifest digest", () => {
    const before = buildManifest("test", [entry("a", "1.0.0", "a-1.0.0.tgz", "original")]);
    const after = buildManifest("test", [entry("a", "1.0.0", "a-1.0.0.tgz", "changed")]);
    expect(before.digest).not.toBe(after.digest);
  });

  test("digest is stable for the same packed set", () => {
    const packed = [entry("a", "1.0.0", "a-1.0.0.tgz", "content")];
    expect(buildManifest("test", packed).digest).toBe(buildManifest("test", packed).digest);
  });

  test("empty packed set produces an empty manifest with a digest", () => {
    const manifest = buildManifest("test", []);
    expect(manifest.packages).toEqual([]);
    expect(manifest.digest).toHaveLength(64);
  });
});

describe("buildPackedEntries", () => {
  test("every packed manifest declares only registry specs, and real npm manifests are untouched", async () => {
    const entries = await buildPackedEntries();
    expect(entries.length).toBeGreaterThan(10);
    const names = new Set(entries.map((entry) => entry.name));
    // The three packages #31 found shipping workspace-only specs, and the
    // runtime package the tools author with (#42); the app package itself is
    // no longer part of any specialist's closure.
    for (const name of ["@intx/types", "@solutions-builder/tools-deck", "@solutions-builder/tools-delivery", "@solutions-builder/specialist-runtime"]) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.has("@solutions-builder/app")).toBe(false);
    const untouched = new Map<string, string>();
    for (const entry of entries) {
      const files = await extractTarballFiles(entry.bytes);
      const manifestText = files["package.json"];
      expect(manifestText).toBeDefined();
      const manifest = JSON.parse(manifestText!) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      expect(manifest.name).toBe(entry.name);
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
        for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
          if (!isRegistrySpec(spec)) throw new Error(`${entry.name} ${field}.${dep} is "${spec}"`);
        }
      }
      if (entry.name === "hono") untouched.set(entry.name, manifestText!);
    }
    // A real npm package's manifest is packed byte-for-byte.
    const honoDir = dirname(Bun.resolveSync("hono/package.json", ROOT_DIR));
    expect(untouched.get("hono")).toBe(readFileSync(join(honoDir, "package.json"), "utf8"));
  }, 60_000);
});

describe("rewriteDependencies", () => {
  test("rewrites every workspace-only spec prefix and keeps registry ranges", () => {
    expect(
      rewriteDependencies({
        a: "workspace:*",
        b: "workspace:^1.0.0",
        c: "catalog:",
        d: "catalog:react",
        e: "link:../x",
        f: "file:../y",
        g: "^2.1.0",
        h: "0.4.0",
      }),
    ).toEqual({ a: "*", b: "*", c: "*", d: "*", e: "*", f: "*", g: "^2.1.0", h: "0.4.0" });
  });
});

describe("isRepoPackageDir", () => {
  test("tells this repository's own packages from installed npm packages", () => {
    expect(isRepoPackageDir(dirname(Bun.resolveSync("@intx/types/package.json", ROOT_DIR)))).toBe(true);
    expect(isRepoPackageDir(dirname(Bun.resolveSync("@solutions-builder/tools-deck/package.json", ROOT_DIR)))).toBe(true);
    expect(isRepoPackageDir(dirname(Bun.resolveSync("hono/package.json", ROOT_DIR)))).toBe(false);
    expect(isRepoPackageDir(ROOT_DIR)).toBe(false);
  });
});
