import { describe, expect, test } from "bun:test";
import { agentFor } from "@solutions-builder/app/kit";
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

// #42: every specialist used to ship the whole app package, both tool
// packages and their npm trees (pptxgenjs, jszip) whatever its entry
// imported. Now the tree carries the members the entry resolves against.
describe("renderSpecialistSource members", () => {
  const render = async (stage: Stage, roleKey = "primary", artifactTools = false) =>
    renderSpecialistSource(
      await fullClosure(),
      "proj_1",
      stage,
      { provider: "openai", model: "gpt-5.5" },
      artifactTools,
      roleKey,
      agentFor(stage),
      artifactTools ? "crd_test" : undefined,
    );

  test("a specialist that imports no tool ships the vendored workflow alone", async () => {
    for (const stage of [1, 2, 3, 4, 6, 7, 8] as Stage[]) {
      const files = await render(stage);
      expect(membersOf(files)).toEqual(["intx-workflow"]);
      const deps = dependenciesOf(files);
      expect(Object.keys(deps).filter((name) => name.startsWith("@solutions-builder/"))).toEqual([]);
      expect(deps["@intx/tools-posix"]).toBeUndefined();
    }
  });

  test("stage 5's one deployment ships no tool: the app draws slides from the outline (#435)", async () => {
    const packages = await render(5);
    expect(membersOf(packages)).toEqual(["intx-workflow"]);
    expect(dependenciesOf(packages)["@solutions-builder/tools-deck"]).toBeUndefined();
    expect(dependenciesOf(packages)["@solutions-builder/tools-delivery"]).toBeUndefined();
  });

  test("stage 9 ships the delivery tool and the runtime, and no stage depends on the shell", async () => {
    const build = await render(8);
    expect(membersOf(build)).toEqual(["intx-workflow"]);
    expect(dependenciesOf(build)["@intx/tools-posix"]).toBeUndefined();
    const deliver = await render(9);
    expect(membersOf(deliver)).toEqual(["intx-workflow", "specialist-runtime", "tools-delivery"]);
    expect(dependenciesOf(deliver)["@intx/tools-posix"]).toBeUndefined();
  });

  test("the generic artifact bundle ships only when asked for", async () => {
    const bound = await render(2, "primary", true);
    expect(membersOf(bound)).toEqual(["corbits-artifacts", "intx-workflow"]);
    expect(dependenciesOf(bound)["@corbits/artifacts"]).toBe("workspace:*");
    expect(bound["packages/specialist/workflow.js"]).toContain('"resource":"credential:crd_test"');
    expect(bound["packages/specialist/workflow.js"]).toContain('"action":"use"');
    expect(bound["packages/specialist/workflow.js"]).toContain('"source":"creator"');
    expect(bound["packages/specialist/workflow.js"]).toContain('"conditions":{"tool":"tool:@corbits/artifacts/sidecar-bundle"}');
    expect(membersOf(await render(8, "primary", true))).toEqual(["corbits-artifacts", "intx-workflow"]);
  });

  // #41 step 5: the rendered entry for a role is identical across projects;
  // only the package's own name carries the project, since the asset is
  // named for it. The one exception is the id of the project's own artifacts
  // credential, which a credential-bound entry's use-grant names (#288).
  test("the same role renders the same entry for two projects, up to the credential id", async () => {
    const closure = await fullClosure();
    for (const [stage, artifactTools] of [[1, false], [5, false], [8, false], [8, true], [9, true]] as [Stage, boolean][]) {
      const one = await renderSpecialistSource(closure, "proj_1", stage, { provider: "openai", model: "gpt-5.5" }, artifactTools, "primary", agentFor(stage), artifactTools ? "crd_one" : undefined);
      const two = await renderSpecialistSource(closure, "proj_2", stage, { provider: "openai", model: "gpt-5.5" }, artifactTools, "primary", agentFor(stage), artifactTools ? "crd_two" : undefined);
      const entry = "packages/specialist/workflow.js";
      expect(one[entry]!.replaceAll("crd_one", "crd_x")).toBe(two[entry]!.replaceAll("crd_two", "crd_x"));
      expect(one[entry]).not.toContain("proj_1");
    }
  });

  test("every member the package depends on is in the tree, and nothing in the tree is undeclared", async () => {
    for (const [stage, roleKey, artifactTools] of [[1, "primary", false], [5, "primary", false], [8, "primary", false], [9, "primary", true]] as [Stage, string, boolean][]) {
      const files = await render(stage, roleKey, artifactTools);
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
