import { describe, expect, test } from "bun:test";
import { defaultExportModule, type PackedSpecialist } from "@solutions-builder/app/specialist-source";
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

/** What `scripts/specialist-pack.ts` writes for a role: its entry, and the
 *  dependencies its own package declares. The render copies the bytes and
 *  ships what is declared, so stubs exercise the same path;
 *  `scripts/specialist-pack.test.ts` checks the real packages. */
const BARE_WORKFLOW = 'import { defineWorkflow, step } from "@intx/workflow";\nimport SOURCE from "./inference-source.js";\nexport default defineWorkflow({});\n';
const BASE_DECLARED = ["@intx/agent", "@intx/workflow", "@solutions-builder/specialist-shared"];
const BARE_ENTRY: PackedSpecialist = { roleId: "brainstormer", workflow: BARE_WORKFLOW, dependencies: BASE_DECLARED };
const DELIVERY_ENTRY: PackedSpecialist = {
  roleId: "delivery-verifier",
  workflow: `import { deliver } from "@solutions-builder/tools-delivery/sidecar-bundle";\n${BARE_WORKFLOW}`,
  dependencies: [...BASE_DECLARED, "@solutions-builder/tools-delivery"],
};
const ARTIFACTS_ENTRY: PackedSpecialist = {
  roleId: "constraints-mapper",
  workflow: `import { artifacts } from "@corbits/artifacts/sidecar-bundle";\n${BARE_WORKFLOW}`,
  dependencies: [...BASE_DECLARED, "@corbits/artifacts"],
};

// #42: every specialist used to ship the whole app package, both tool
// packages and their npm trees (pptxgenjs, jszip) whatever its entry
// imported. Now the tree carries the members the entry resolves against.
describe("renderSpecialistSource members", () => {
  const pin = { provider: "openai", model: "gpt-5.5" } as const;
  const guidance = "Write in British English.";
  const render = async (stage: Stage, entry: PackedSpecialist, roleKey = "primary") =>
    renderSpecialistSource(await fullClosure(), "proj_1", stage, pin, roleKey, entry, guidance);

  test("a role that declares no tool ships the vendored workflow alone", async () => {
    for (const stage of [1, 2, 3, 4, 5, 6, 7, 8] as Stage[]) {
      const files = await render(stage, BARE_ENTRY);
      expect(membersOf(files)).toEqual(["intx-workflow"]);
      const deps = dependenciesOf(files);
      expect(Object.keys(deps).filter((name) => name.startsWith("@solutions-builder/"))).toEqual([]);
      expect(deps["@intx/tools-posix"]).toBeUndefined();
    }
  });

  test("a role declaring the delivery tool ships it and the runtime, and no shell", async () => {
    const deliver = await render(9, DELIVERY_ENTRY);
    expect(membersOf(deliver)).toEqual(["intx-workflow", "specialist-runtime", "tools-delivery"]);
    expect(dependenciesOf(deliver)["@intx/tools-posix"]).toBeUndefined();
  });

  test("the generic artifact bundle ships only when the role declares it", async () => {
    const bound = await render(2, ARTIFACTS_ENTRY);
    expect(membersOf(bound)).toEqual(["corbits-artifacts", "intx-workflow"]);
    expect(dependenciesOf(bound)["@corbits/artifacts"]).toBe("workspace:*");
  });

  test("the rendered entry is the packed file, and the pin and guidance are the overlays", async () => {
    const files = await render(1, BARE_ENTRY);
    expect(files["packages/specialist/workflow.js"]).toBe(BARE_WORKFLOW);
    expect(files["packages/specialist/inference-source.js"]).toBe(defaultExportModule(pin));
    expect(files["packages/specialist/workspace-guidance.js"]).toBe(defaultExportModule(guidance));
    expect(files["packages/specialist/workflow.js"]).not.toContain("gpt-5.5");
    expect(files["packages/specialist/workflow.js"]).not.toContain(guidance);
  });

  // #41 step 5: the packed entry for a role is identical across projects;
  // only the package's own name carries the project, since the asset is
  // named for it. The model pin is the overlay, not the entry.
  test("the same entry is copied unchanged for two projects", async () => {
    const closure = await fullClosure();
    for (const [stage, entry] of [
      [1, BARE_ENTRY],
      [9, DELIVERY_ENTRY],
    ] as [Stage, PackedSpecialist][]) {
      const one = await renderSpecialistSource(closure, "proj_1", stage, pin, "primary", entry, guidance);
      const two = await renderSpecialistSource(closure, "proj_2", stage, pin, "primary", entry, guidance);
      const path = "packages/specialist/workflow.js";
      expect(one[path]).toBe(two[path]);
      expect(one[path]).toBe(entry.workflow);
      expect(one[path]).not.toContain("proj_1");
    }
  });

  test("every member the package depends on is in the tree, and nothing in the tree is undeclared", async () => {
    for (const [stage, entry] of [
      [1, BARE_ENTRY],
      [9, DELIVERY_ENTRY],
      [2, ARTIFACTS_ENTRY],
    ] as [Stage, PackedSpecialist][]) {
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
