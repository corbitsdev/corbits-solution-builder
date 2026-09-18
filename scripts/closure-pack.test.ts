import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildManifest, manifestEntry, type PackedEntry } from "./closure-pack.js";

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
