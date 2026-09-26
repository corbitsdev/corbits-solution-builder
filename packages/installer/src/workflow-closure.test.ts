import { describe, expect, test } from "bun:test";
import { packTarballFiles, tarballFilename } from "./tarball-pack.js";
import {
  ARTIFACTS_MISSING_RUNTIME_DEPENDENCIES,
  appMemberFiles,
  artifactsMemberFiles,
  memberDir,
  toolsDeckMemberFiles,
  toolsDeliveryMemberFiles,
  treeDigest,
  vendoredMemberFiles,
  withPatchedDependencies,
  type ClosureTarballFetcher,
} from "./workflow-closure.js";
import type { ClosureManifest } from "./closure-manifest.js";

/**
 * A synthetic closure manifest built from real `packTarballFiles` output
 * (the same packer `scripts/closure-pack.ts` uses), so these tests exercise
 * the real extraction/re-keying path `renderLifecycleSource` drives at
 * deploy time without needing the full vendor tree built.
 */
async function fakeClosure(): Promise<{ manifest: ClosureManifest; fetchTarball: ClosureTarballFetcher }> {
  const packages: { name: string; version: string; files: Record<string, string> }[] = [
    {
      name: "@intx/workflow",
      version: "0.0.0",
      files: {
        "package.json": '{"name":"@intx/workflow","version":"0.0.0","type":"module"}\n',
        "dist/index.js": "export const workflow = true;\n",
      },
    },
    {
      name: "@solutions-builder/app",
      version: "0.1.0",
      files: {
        "package.json": '{"name":"@solutions-builder/app","version":"0.1.0","type":"module"}\n',
        "src/deck.ts": "export function deck() {}\n",
        "src/admit.ts": "export function admitGate() {}\n",
      },
    },
    {
      name: "@solutions-builder/tools-deck",
      version: "0.1.0",
      files: {
        "package.json": '{"name":"@solutions-builder/tools-deck","version":"0.1.0","type":"module"}\n',
        "src/sidecar-bundle.ts": "export const bundle = true;\n",
      },
    },
    {
      name: "@solutions-builder/tools-delivery",
      version: "0.1.0",
      files: {
        "package.json": '{"name":"@solutions-builder/tools-delivery","version":"0.1.0","type":"module"}\n',
        "src/sidecar-bundle.ts": "export const bundle = true;\n",
      },
    },
    {
      name: "@corbits/artifacts",
      version: "0.1.0",
      files: {
        "package.json":
          '{"name":"@corbits/artifacts","version":"0.1.0","type":"module","peerDependencies":{"@intx/agent":"*","@intx/types":"*","arktype":"^2.1.29","hono":"*"}}\n',
        "src/sidecar-bundle.ts": "export const bundle = true;\n",
      },
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

  const manifest: ClosureManifest = {
    digest: "test",
    packages: manifestPackages,
    catalog: { arktype: "^2.0.0" },
  };
  const fetchTarball: ClosureTarballFetcher = async (filename) => {
    const bytes = byFilename.get(filename);
    if (bytes === undefined) throw new Error(`no packed entry for ${filename}`);
    return bytes;
  };
  return { manifest, fetchTarball };
}

describe("workflow-closure", () => {
  test("vendoredMemberFiles ships @intx/workflow as the only member", async () => {
    const { manifest, fetchTarball } = await fakeClosure();
    const files = await vendoredMemberFiles(manifest, fetchTarball);
    const dir = memberDir("workflow");
    expect(files[`${dir}/package.json`]).toContain('"name":"@intx/workflow"');
    expect(files[`${dir}/dist/index.js`]).toContain("export const workflow");
    expect((await treeDigest(files)).length).toBe(64);
  });

  test("app and tools members extract from their own tarballs", async () => {
    const { manifest, fetchTarball } = await fakeClosure();
    const app = await appMemberFiles(manifest, fetchTarball);
    expect(app["packages/solutions-builder-app/src/deck.ts"]).toContain("export function deck");
    expect(app["packages/solutions-builder-app/src/admit.ts"]).toContain("admitGate");

    const deck = await toolsDeckMemberFiles(manifest, fetchTarball);
    expect(deck["packages/tools-deck/src/sidecar-bundle.ts"]).toContain("bundle");

    const delivery = await toolsDeliveryMemberFiles(manifest, fetchTarball);
    expect(delivery["packages/tools-delivery/src/sidecar-bundle.ts"]).toContain("bundle");
  });

  test("the shipped @corbits/artifacts member pins @intx/agent and @intx/types to registry versions", async () => {
    const { manifest, fetchTarball } = await fakeClosure();
    const files = await artifactsMemberFiles(manifest, fetchTarball);
    const packageJson = JSON.parse(files["packages/corbits-artifacts/package.json"]!) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    const registryRange = /^\d+\.\d+\.\d+$/;
    expect(packageJson.dependencies["@intx/agent"]).toMatch(registryRange);
    expect(packageJson.dependencies["@intx/types"]).toMatch(registryRange);
    expect(packageJson.dependencies["@intx/types"]).toBe(packageJson.dependencies["@intx/agent"]);
    for (const spec of Object.values(packageJson.dependencies)) expect(spec).not.toMatch(/^(workspace|catalog):/);
    // Moved, not duplicated: the peer entry would otherwise conflict.
    expect(packageJson.peerDependencies["@intx/agent"]).toBeUndefined();
    expect(packageJson.peerDependencies.arktype).toBeUndefined();
    expect(packageJson.peerDependencies.hono).toBe("*");
    expect(files["packages/corbits-artifacts/src/sidecar-bundle.ts"]).toContain("bundle");
  });

  test("withPatchedDependencies refuses a workspace:* spec for a name that is not a member", () => {
    const original = '{"name":"x","version":"0.0.0"}';
    expect(() => withPatchedDependencies(original, { "@intx/agent": "workspace:*" })).toThrow(
      /@intx\/agent .*not a workspace member/,
    );
    expect(() => withPatchedDependencies(original, { "@intx/workflow": "workspace:*" })).not.toThrow();
    for (const spec of Object.values(ARTIFACTS_MISSING_RUNTIME_DEPENDENCIES)) expect(spec).not.toMatch(/^workspace:/);
  });
});
