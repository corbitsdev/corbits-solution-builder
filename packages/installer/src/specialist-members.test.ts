import { describe, expect, test } from "bun:test";
import { inferenceSourceModule } from "@solutions-builder/app/specialist-source";
import type { Stage } from "@solutions-builder/app/ledger";
import { renderSpecialistSource } from "./specialist-deploy.js";
import { packTarballFiles, tarballFilename } from "./tarball-pack.js";
import type { ClosureManifest } from "./closure-manifest.js";
import type { ClosureSource } from "./workflow-deploy.js";

/** A closure holding every member any specialist can ship, so what a
 *  rendered tree leaves out is a choice, not an absence. */
async function fullClosure(): Promise<ClosureSource> {
  const packages: { name: string; version: string; files: Record<string, string> }[] = [
    { name: "@intx/workflow", version: "0.0.0", files: { "package.json": '{"name":"@intx/workflow","version":"0.0.0"}\n', "dist/index.js": "" } },
    { name: "@solutions-builder/specialist-runtime", version: "0.1.0", files: { "package.json": '{"name":"@solutions-builder/specialist-runtime","version":"0.1.0"}\n', "src/deck.ts": "" } },
    { name: "@solutions-builder/tools-deck", version: "0.1.0", files: { "package.json": '{"name":"@solutions-builder/tools-deck","version":"0.1.0"}\n', "src/sidecar-bundle.ts": "" } },
    { name: "@solutions-builder/tools-delivery", version: "0.1.0", files: { "package.json": '{"name":"@solutions-builder/tools-delivery","version":"0.1.0"}\n', "src/sidecar-bundle.ts": "" } },
    { name: "@corbits/artifacts", version: "0.1.0", files: { "package.json": '{"name":"@corbits/artifacts","version":"0.1.0","peerDependencies":{}}\n', "src/sidecar-bundle.ts": "" } },
  ];
  const byFilename = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const entries = [];
  for (const pkg of packages) {
    const encoded: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(pkg.files)) encoded[path] = encoder.encode(content);
    const filename = tarballFilename(pkg.name, pkg.version);
    byFilename.set(filename, await packTarballFiles(encoded));
    entries.push({ name: pkg.name, version: pkg.version, filename, sha256: "" });
  }
  const manifest: ClosureManifest = { digest: "test", packages: entries, catalog: {} };
  return {
    manifest,
    fetchTarball: async (filename) => {
      const bytes = byFilename.get(filename);
      if (!bytes) throw new Error(`no packed entry for ${filename}`);
      return bytes;
    },
  };
}

/** The member directories a rendered tree carries beside the specialist itself. */
function membersOf(files: Record<string, string>): string[] {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const match = /^packages\/([^/]+)\//.exec(path);
    if (match && match[1] !== "specialist") dirs.add(match[1]!);
  }
  return [...dirs].sort();
}

function dependenciesOf(files: Record<string, string>): Record<string, string> {
  return (JSON.parse(files["packages/specialist/package.json"]!) as { dependencies: Record<string, string> }).dependencies;
}

/** What `scripts/specialist-pack.ts` leaves of an entry's imports: the
 *  externals by name, everything else bundled. The render copies bytes and
 *  reads imports, so a stub with the same imports exercises the same path;
 *  `scripts/specialist-pack.test.ts` checks the real packages' bytes. */
const BARE_ENTRY = 'import { defineWorkflow, step } from "@intx/workflow";\nimport SOURCE from "./inference-source.js";\nexport default defineWorkflow({});\n';
const DELIVERY_ENTRY = `import { deliver } from "@solutions-builder/tools-delivery/sidecar-bundle";\n${BARE_ENTRY}`;
const ARTIFACTS_ENTRY = `import { artifacts } from "@corbits/artifacts/sidecar-bundle";\n${BARE_ENTRY}`;

// #42: every specialist used to ship the whole app package, both tool
// packages and their npm trees (pptxgenjs, jszip) whatever its entry
// imported. Now the tree carries the members the entry resolves against.
describe("renderSpecialistSource members", () => {
  const pin = { provider: "openai", model: "gpt-5.5" } as const;
  const render = async (stage: Stage, entry: string, roleKey = "primary") =>
    renderSpecialistSource(await fullClosure(), "proj_1", stage, pin, roleKey, entry);

  test("an entry that imports no tool ships the vendored workflow alone", async () => {
    for (const stage of [1, 2, 3, 4, 5, 6, 7, 8] as Stage[]) {
      const files = await render(stage, BARE_ENTRY);
      expect(membersOf(files)).toEqual(["intx-workflow"]);
      const deps = dependenciesOf(files);
      expect(Object.keys(deps).filter((name) => name.startsWith("@solutions-builder/"))).toEqual([]);
      expect(deps["@intx/tools-posix"]).toBeUndefined();
    }
  });

  test("an entry importing the delivery tool ships it and the runtime, and no shell", async () => {
    const deliver = await render(9, DELIVERY_ENTRY);
    expect(membersOf(deliver)).toEqual(["intx-workflow", "specialist-runtime", "tools-delivery"]);
    expect(dependenciesOf(deliver)["@intx/tools-posix"]).toBeUndefined();
  });

  test("the generic artifact bundle ships only when the entry imports it", async () => {
    const bound = await render(2, ARTIFACTS_ENTRY);
    expect(membersOf(bound)).toEqual(["corbits-artifacts", "intx-workflow"]);
    expect(dependenciesOf(bound)["@corbits/artifacts"]).toBe("workspace:*");
  });

  test("the rendered entry is the packed file, and the pin is the overlay", async () => {
    const files = await render(1, BARE_ENTRY);
    expect(files["packages/specialist/workflow.js"]).toBe(BARE_ENTRY);
    expect(files["packages/specialist/inference-source.js"]).toBe(inferenceSourceModule(pin));
    expect(files["packages/specialist/workflow.js"]).not.toContain("gpt-5.5");
  });

  // #41 step 5: the packed entry for a role is identical across projects;
  // only the package's own name carries the project, since the asset is
  // named for it. The model pin is the overlay, not the entry.
  test("the same entry is copied unchanged for two projects", async () => {
    const closure = await fullClosure();
    for (const [stage, entry] of [
      [1, BARE_ENTRY],
      [9, DELIVERY_ENTRY],
    ] as [Stage, string][]) {
      const one = await renderSpecialistSource(closure, "proj_1", stage, pin, "primary", entry);
      const two = await renderSpecialistSource(closure, "proj_2", stage, pin, "primary", entry);
      const path = "packages/specialist/workflow.js";
      expect(one[path]).toBe(two[path]);
      expect(one[path]).toBe(entry);
      expect(one[path]).not.toContain("proj_1");
    }
  });

  test("every member the package depends on is in the tree, and nothing in the tree is undeclared", async () => {
    for (const [stage, entry] of [
      [1, BARE_ENTRY],
      [9, DELIVERY_ENTRY],
      [2, ARTIFACTS_ENTRY],
    ] as [Stage, string][]) {
      const files = await render(stage, entry);
      const declaredMembers = Object.entries(dependenciesOf(files))
        .filter(([, spec]) => spec === "workspace:*")
        .map(([name]) => name);
      const shipped = membersOf(files);
      for (const name of declaredMembers) {
        const dir = name === "@intx/workflow" ? "intx-workflow" : name === "@corbits/artifacts" ? "corbits-artifacts" : name.replace("@solutions-builder/", "");
        expect(shipped).toContain(dir);
      }
      expect(shipped.length).toBe(declaredMembers.length);
    }
  });
});
