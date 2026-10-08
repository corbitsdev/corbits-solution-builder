import { describe, expect, test } from "bun:test";
import {
  credentialAccess,
  ARTIFACT_TOOL_DEPENDENCIES,
  DECK_TOOL_DEPENDENCIES,
  DELIVERY_TOOL_DEPENDENCIES,
  POSIX_TOOL_DEPENDENCIES,
  SPECIALIST_BASE_DEPENDENCIES,
  defaultExportModule,
  specialistDependencies,
  specialistTooling,
  WORKFLOW_PACKAGE_DEPENDENCIES,
} from "./specialist-source.js";
import { composeSpecialistPrompt } from "@solutions-builder/specialist-shared/deploy-overlays";
import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";

const NONE = { deck: false, posix: false, delivery: false, artifacts: false };

const BARE = ["@intx/agent", "@intx/workflow", "@solutions-builder/specialist-shared"];
const DELIVERY = [...BARE, "@solutions-builder/tools-delivery"];
const ARTIFACTS = [...BARE, "@corbits/artifacts"];

// #42: a specialist ships only what its role package declares, as any
// Interchange package does, so the tooling is read off those declarations
// rather than decided a second time here.
describe("specialistTooling", () => {
  test("a role declaring no tool package carries nothing", () => {
    expect(specialistTooling(BARE)).toEqual(NONE);
  });

  test("each declared tool package is its tool", () => {
    expect(specialistTooling(DELIVERY)).toEqual({ ...NONE, delivery: true });
    expect(specialistTooling(ARTIFACTS)).toEqual({ ...NONE, artifacts: true });
    expect(specialistTooling([...BARE, "@solutions-builder/tools-deck"])).toEqual({ ...NONE, deck: true });
    expect(specialistTooling([...BARE, "@intx/tools-posix"])).toEqual({ ...NONE, posix: true });
    expect(specialistTooling([...DELIVERY, "@corbits/artifacts"])).toEqual({ ...NONE, delivery: true, artifacts: true });
  });

  test("a similarly named package is not the tool", () => {
    expect(specialistTooling([...BARE, "@solutions-builder/tools-delivery-extras"])).toEqual(NONE);
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

describe("defaultExportModule", () => {
  test("exports the value as the default, nothing else", () => {
    expect(defaultExportModule({ provider: "openai", model: "gpt-5.5" })).toBe(`export default {"provider":"openai","model":"gpt-5.5"};\n`);
    expect(defaultExportModule("Write in British English.")).toBe(`export default "Write in British English.";\n`);
  });
});

// The order main rendered: a specialist moved to a packed entry is told
// exactly what it was told before.
describe("composeSpecialistPrompt", () => {
  const role = { id: "probe", system: "Role text." };

  test("puts the guidance after the role's text and before its skills", () => {
    expect(composeSpecialistPrompt(role, "Guidance line.")).toBe(`Role text.\n\nGuidance line.\n\n${skillTextFor(role)}`);
  });

  test("leaves no guidance section when there is none", () => {
    expect(composeSpecialistPrompt(role, "")).toBe(`Role text.\n\n${skillTextFor(role)}`);
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
