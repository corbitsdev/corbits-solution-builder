import { describe, expect, test } from "bun:test";
import { agentFor } from "./kit.js";
import type { Stage } from "./ledger.js";
import {
  credentialAccess,
  ARTIFACT_TOOL_DEPENDENCIES,
  DECK_TOOL_DEPENDENCIES,
  DELIVERY_TOOL_DEPENDENCIES,
  POSIX_TOOL_DEPENDENCIES,
  SPECIALIST_BASE_DEPENDENCIES,
  specialistDependencies,
  specialistEntrySource,
  specialistTooling,
  WORKFLOW_PACKAGE_DEPENDENCIES,
} from "./specialist-source.js";

const NONE = { deck: false, posix: false, delivery: false, artifacts: false };

// #42: a specialist ships only what its entry imports. The tooling matrix is
// what decides both the entry's imports and the members and dependencies
// beside it, so it is pinned here, stage by stage.
describe("specialistTooling", () => {
  test("stages 1 to 4, 6 and 7 import no tool", () => {
    for (const stage of [1, 2, 3, 4, 6, 7] as Stage[]) {
      expect(specialistTooling({ stage })).toEqual(NONE);
    }
  });

  test("stage 5 carries the deck: its one deployment renders every stakeholder's slides (#41 step 3)", () => {
    expect(specialistTooling({ stage: 5 })).toEqual({ ...NONE, deck: true });
    expect(specialistTooling({ stage: 5, roleKey: "primary" })).toEqual({ ...NONE, deck: true });
  });

  test("stage 8 carries the shell and the delivery tool, and never the generic artifact bundle", () => {
    expect(specialistTooling({ stage: 8 })).toEqual({ ...NONE, posix: true, delivery: true });
    expect(specialistTooling({ stage: 8, artifactTools: true })).toEqual({ ...NONE, posix: true, delivery: true });
  });

  test("stage 9 carries the delivery tool alone", () => {
    expect(specialistTooling({ stage: 9 })).toEqual({ ...NONE, delivery: true });
  });

  test("the generic artifact bundle is opt-in on any stage but 8", () => {
    expect(specialistTooling({ stage: 2, artifactTools: true })).toEqual({ ...NONE, artifacts: true });
    expect(specialistTooling({ stage: 9, artifactTools: true })).toEqual({ ...NONE, delivery: true, artifacts: true });
  });
});

describe("specialistDependencies", () => {
  test("a tool-less specialist depends on the base set alone: no app, deck, delivery or pptx", () => {
    const deps = specialistDependencies(specialistTooling({ stage: 1 }));
    expect(deps).toEqual(SPECIALIST_BASE_DEPENDENCIES);
    expect(Object.keys(deps).some((name) => name.startsWith("@solutions-builder/"))).toBe(false);
  });

  test("each tool brings its own set, and the runtime package comes with the deck or delivery tool", () => {
    expect(specialistDependencies(specialistTooling({ stage: 5 }))).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...DECK_TOOL_DEPENDENCIES });
    expect(specialistDependencies(specialistTooling({ stage: 8 }))).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...POSIX_TOOL_DEPENDENCIES, ...DELIVERY_TOOL_DEPENDENCIES });
    expect(specialistDependencies(specialistTooling({ stage: 9 }))).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...DELIVERY_TOOL_DEPENDENCIES });
    expect(specialistDependencies(specialistTooling({ stage: 3, artifactTools: true }))).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...ARTIFACT_TOOL_DEPENDENCIES });
    expect(DECK_TOOL_DEPENDENCIES["@solutions-builder/specialist-runtime"]).toBe("workspace:*");
    expect(DELIVERY_TOOL_DEPENDENCIES["@solutions-builder/specialist-runtime"]).toBe("workspace:*");
  });

  test("the packed union covers every set, and names the app package nowhere", () => {
    for (const set of [SPECIALIST_BASE_DEPENDENCIES, POSIX_TOOL_DEPENDENCIES, DECK_TOOL_DEPENDENCIES, DELIVERY_TOOL_DEPENDENCIES]) {
      for (const [name, spec] of Object.entries(set)) expect(WORKFLOW_PACKAGE_DEPENDENCIES[name]).toBe(spec);
    }
    expect(WORKFLOW_PACKAGE_DEPENDENCIES["@solutions-builder/app"]).toBeUndefined();
  });
});

describe("specialistEntrySource", () => {
  const entry = (stage: Stage, roleKey = "primary", artifactTools = false) =>
    specialistEntrySource({
      stage,
      source: { provider: "openai", model: "gpt-5.5" },
      role: agentFor(stage),
      roleKey,
      artifactTools,
      ...(artifactTools ? { artifactCredentialId: "crd_test" } : {}),
    });

  test("imports exactly the tools the tooling matrix names", () => {
    const stage1 = entry(1);
    expect(stage1).not.toContain("@solutions-builder/");
    expect(stage1).not.toContain("@intx/tools-posix");
    expect(stage1).not.toContain("@corbits/artifacts");

    expect(entry(5)).toContain('from "@solutions-builder/tools-deck/sidecar-bundle"');

    const stage8 = entry(8);
    expect(stage8).toContain('from "@intx/tools-posix/sidecar-bundle"');
    expect(stage8).toContain('from "@solutions-builder/tools-delivery/publish-workspace"');
    expect(stage8).not.toContain("@corbits/artifacts/sidecar-bundle");

    expect(entry(9)).toContain('from "@solutions-builder/tools-delivery/sidecar-bundle"');
    expect(entry(9)).not.toContain("tools-deck");

    expect(entry(2, "primary", true)).toContain('from "@corbits/artifacts/sidecar-bundle"');
  });

  // #41 step 3: who a package is for arrives with the request, so the
  // rendered entry names no stakeholder and needs no redeploy when the
  // project's audiences change.
  // #41 step 4: what a document-writing specialist needs to know is its
  // stage and kind, fixed per role; the project is the run's own tenant.
  test("an entry with the artifact tools names its stage and kind, never a project", () => {
    const stage2 = entry(2, "primary", true);
    expect(stage2).toContain("## Stage document");
    expect(stage2).toContain("stage 2 specialist");
    expect(stage2).toContain("`solution_constraints`");
    expect(stage2).not.toContain("## Artifact context");
    expect(stage2).not.toContain("projectId:");
    expect(entry(2)).not.toContain("## Stage document");
  });

  // #41 step 5: the entry takes nothing of the project's. The credential
  // binding is named for the role, and `publish_workspace` is built with no
  // project id, so the same role renders the same entry everywhere.
  test("a credential-bound entry names its binding for the role, and stage 8 builds publish_workspace unbound", () => {
    expect(entry(2, "primary", true)).toContain('"name":"workflow-artifacts:constraints-mapper"');
    expect(entry(8)).toContain("const publishWorkspace = publishWorkspaceTool();");
    expect(entry(8, "primary", true)).toContain('"name":"workflow-artifacts:build-engineer"');
  });

  // #288: the binding delivers the credential, the requirement lets the run
  // use it, and both name the same consumer -- the bundle's own id.
  test("a credential-bound entry declares the use-grant its run needs, scoped to the bound package", () => {
    expect(credentialAccess("@corbits/artifacts/sidecar-bundle", "workflow-artifacts:brainstormer", "crd_1")).toEqual({
      credentialBindings: [
        { package: "@corbits/artifacts/sidecar-bundle", handle: "hub", provider: "sb-workflow-artifacts", name: "workflow-artifacts:brainstormer", locator: "tenant" },
      ],
      grantRequirements: [
        { resource: "credential:crd_1", action: "use", source: "creator", conditions: { tool: "tool:@corbits/artifacts/sidecar-bundle" } },
      ],
    });
    expect(entry(2, "primary", true)).toContain('"conditions":{"tool":"tool:@corbits/artifacts/sidecar-bundle"}');
    expect(entry(8, "primary", true)).toContain('"conditions":{"tool":"tool:@solutions-builder/tools-delivery/publish-workspace"}');
    expect(entry(2, "primary", true)).toContain('"resource":"credential:crd_test"');
    expect(entry(2)).not.toContain("grantRequirements");
    expect(() => specialistEntrySource({ stage: 2, source: { provider: "openai", model: "gpt-5.5" }, role: agentFor(2), roleKey: "primary", artifactTools: true })).toThrow(/credential/);
  });

  test("stage 5's entry names no audience", () => {
    const stage5 = entry(5);
    expect(stage5).not.toContain("## Audiences");
    expect(stage5).not.toContain("project_owner");
    expect(stage5).not.toContain("carries no deck tool");
  });
});
