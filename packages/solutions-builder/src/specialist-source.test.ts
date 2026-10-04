import { describe, expect, test } from "bun:test";
import type { Stage } from "./ledger.js";
import {
  credentialAccess,
  ARTIFACT_TOOL_DEPENDENCIES,
  DECK_TOOL_DEPENDENCIES,
  DELIVERY_TOOL_DEPENDENCIES,
  POSIX_TOOL_DEPENDENCIES,
  SPECIALIST_BASE_DEPENDENCIES,
  inferenceSourceModule,
  specialistDependencies,
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

  test("stage 5 carries no tool: the app draws slides from the outline in the reply (#435)", () => {
    expect(specialistTooling({ stage: 5 })).toEqual(NONE);
    expect(specialistTooling({ stage: 5, artifactTools: true })).toEqual({ ...NONE, artifacts: true });
  });

  test("stage 8 carries no tool: the build runs through the host's bridge and its specialist reviews the report", () => {
    expect(specialistTooling({ stage: 8 })).toEqual(NONE);
    expect(specialistTooling({ stage: 8, artifactTools: true })).toEqual({ ...NONE, artifacts: true });
  });

  test("stage 9 carries the delivery tool alone", () => {
    expect(specialistTooling({ stage: 9 })).toEqual({ ...NONE, delivery: true });
  });

  test("the generic artifact bundle is opt-in on any stage", () => {
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
    expect(specialistDependencies(specialistTooling({ stage: 5 }))).toEqual(SPECIALIST_BASE_DEPENDENCIES);
    expect(specialistDependencies({ deck: true, posix: false, delivery: false, artifacts: false })).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...DECK_TOOL_DEPENDENCIES });
    expect(specialistDependencies(specialistTooling({ stage: 8 }))).toEqual(SPECIALIST_BASE_DEPENDENCIES);
    expect(specialistDependencies({ deck: false, posix: true, delivery: false, artifacts: false })).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...POSIX_TOOL_DEPENDENCIES });
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

describe("inferenceSourceModule", () => {
  test("exports the pin as the default, nothing else", () => {
    expect(inferenceSourceModule({ provider: "openai", model: "gpt-5.5" })).toBe(
      `export default {"provider":"openai","model":"gpt-5.5"};\n`,
    );
  });
});

describe("credentialAccess", () => {
  test("names the use-grant for the bound package", () => {
    expect(credentialAccess("@corbits/artifacts/sidecar-bundle", "workflow-artifacts:brainstormer", "crd_1")).toEqual({
      credentialBindings: [
        { package: "@corbits/artifacts/sidecar-bundle", handle: "hub", provider: "sb-workflow-artifacts", name: "workflow-artifacts:brainstormer", locator: "tenant" },
      ],
      grantRequirements: [
        { resource: "credential:crd_1", action: "use", source: "creator", conditions: { tool: "tool:@corbits/artifacts/sidecar-bundle" } },
      ],
    });
  });
});
