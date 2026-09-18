import { describe, expect, test } from "bun:test";
import { AssetRegistrySource, createClosureResolver, parsePin } from "@intx/tool-packaging";

import { packTarballFiles, tarballFilename } from "./tarball-pack.js";

/**
 * Proves the packer's bytes are exactly what the platform's own resolver
 * expects: `AssetRegistrySource` + `createClosureResolver` are the same two
 * calls `resolveWorkflowClosure`'s asset-tarball arm makes
 * (`vendor/interchange/packages/hub-sessions/src/workflow-closure-resolution.ts`,
 * `isAssetTarballArgs` branch) — reading tarballs this packer wrote, with no
 * vendor changes and no real asset service in the loop.
 */
describe("packTarballFiles", () => {
  function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  test("round-trips a fixture through the vendored resolver's tarball reader", async () => {
    const depManifest = {
      name: "test-dep",
      version: "2.0.0",
      type: "module",
    };
    const depBytes = await packTarballFiles({
      "package.json": encode(`${JSON.stringify(depManifest)}\n`),
      "index.js": encode("export const dep = true;\n"),
    });

    const rootManifest = {
      name: "test-lifecycle-pkg",
      version: "1.0.0",
      type: "module",
      dependencies: { "test-dep": "*" },
      interchange: { workflow: "./entry.js", loops: "./loops.js", actions: "./actions.js" },
    };
    const rootBytes = await packTarballFiles({
      "package.json": encode(`${JSON.stringify(rootManifest)}\n`),
      "entry.js": encode("export function build() { return {}; }\n"),
      "loops.js": encode("export function stillOpen() { return false; }\n"),
      "actions.js": encode("export function admitGate() { return {}; }\n"),
    });

    const rootFilename = tarballFilename(rootManifest.name, rootManifest.version);
    const depFilename = tarballFilename(depManifest.name, depManifest.version);
    const blobs = new Map<string, Uint8Array>([
      [`tarballs/${rootFilename}`, rootBytes],
      [`tarballs/${depFilename}`, depBytes],
    ]);

    const registryName = "asset_test_registry";
    const source = new AssetRegistrySource({
      name: registryName,
      assetId: registryName,
      readBlob: async (path) => {
        const bytes = blobs.get(path);
        if (bytes === undefined) throw new Error(`no blob at ${path}`);
        return bytes;
      },
      listBlobs: async (dir) => {
        if (dir !== "tarballs") throw new Error(`unexpected list dir: ${dir}`);
        return [...blobs.keys()].map((path) => path.slice("tarballs/".length));
      },
    });
    const resolver = createClosureResolver({
      registries: new Map([[registryName, source]]),
      defaultRegistry: registryName,
    });
    const manifest = await resolver.resolveClosure([parsePin(`${rootManifest.name}@${rootManifest.version}`)]);

    expect(
      manifest.entries.map((entry: { name: string; version: string }) => `${entry.name}@${entry.version}`).sort(),
    ).toEqual(["test-dep@2.0.0", "test-lifecycle-pkg@1.0.0"]);
    const root = manifest.entries.find((entry: { name: string }) => entry.name === rootManifest.name);
    expect(root?.source).toEqual({
      kind: "asset",
      assetId: "asset_test_registry",
      package: { format: "tarball", path: `tarballs/${rootFilename}`, integrity: expect.stringMatching(/^sha512-/) },
    });
  });

  test("tarballFilename flattens a scoped name", () => {
    expect(tarballFilename("@solutions-builder/app", "0.1.0")).toBe("@solutions-builder-app-0.1.0.tgz");
  });
});
