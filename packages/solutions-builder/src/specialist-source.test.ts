import { describe, expect, test } from "bun:test";
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

const BARE = 'import { defineWorkflow } from "@intx/workflow";\nimport SOURCE from "./inference-source.js";\n';
const DELIVERY = `${BARE}import { deliver } from "@solutions-builder/tools-delivery/sidecar-bundle";\n`;
const ARTIFACTS = `${BARE}import { artifacts } from '@corbits/artifacts/sidecar-bundle';\n`;

// #42: a specialist ships only what its entry imports, and the entry is the
// package's own `workflow.ts`, so the tooling is read off the packed bytes
// rather than decided a second time here.
describe("specialistTooling", () => {
  test("an entry importing no tool package carries nothing", () => {
    expect(specialistTooling(BARE)).toEqual(NONE);
  });

  test("each external tool import is detected by its package, subpath or not", () => {
    expect(specialistTooling(DELIVERY)).toEqual({ ...NONE, delivery: true });
    expect(specialistTooling(ARTIFACTS)).toEqual({ ...NONE, artifacts: true });
    expect(specialistTooling(`${BARE}import { deck } from "@solutions-builder/tools-deck";\n`)).toEqual({ ...NONE, deck: true });
    expect(specialistTooling(`${BARE}import { shell } from "@intx/tools-posix";\n`)).toEqual({ ...NONE, posix: true });
    expect(specialistTooling(`${DELIVERY}import { artifacts } from "@corbits/artifacts/sidecar-bundle";\n`)).toEqual({ ...NONE, delivery: true, artifacts: true });
  });

  test("a package name inside a string is not an import", () => {
    expect(specialistTooling(`${BARE}const note = "see @solutions-builder/tools-delivery";\n`)).toEqual(NONE);
    expect(specialistTooling(`${BARE}import { x } from "@solutions-builder/tools-delivery-extras";\n`)).toEqual(NONE);
  });
});

describe("specialistDependencies", () => {
  test("a tool-less specialist depends on the base set alone: no app, deck, delivery or pptx", () => {
    const deps = specialistDependencies(specialistTooling(BARE));
    expect(deps).toEqual(SPECIALIST_BASE_DEPENDENCIES);
    expect(Object.keys(deps).some((name) => name.startsWith("@solutions-builder/"))).toBe(false);
  });

  test("each tool brings its own set, and the runtime package comes with the deck or delivery tool", () => {
    expect(specialistDependencies({ deck: true, posix: false, delivery: false, artifacts: false })).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...DECK_TOOL_DEPENDENCIES });
    expect(specialistDependencies({ deck: false, posix: true, delivery: false, artifacts: false })).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...POSIX_TOOL_DEPENDENCIES });
    expect(specialistDependencies(specialistTooling(DELIVERY))).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...DELIVERY_TOOL_DEPENDENCIES });
    expect(specialistDependencies(specialistTooling(ARTIFACTS))).toEqual({ ...SPECIALIST_BASE_DEPENDENCIES, ...ARTIFACT_TOOL_DEPENDENCIES });
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
