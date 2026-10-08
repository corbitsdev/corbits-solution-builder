import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_KIT, agentFor } from "@solutions-builder/app/kit";
import { DELIVERY_STAGE, specialistTooling } from "@solutions-builder/app/specialist-source";
import { buildSpecialistWorkflowFiles, declaredDependencies, EXTERNAL, packSpecialist, ROOT_DIR, SPECIALIST_PACK_ROLES } from "./specialist-pack.ts";

const files = await buildSpecialistWorkflowFiles();

/** The bare package specifiers a packed entry still imports. */
function externalImportsOf(packed: string): string[] {
  const found = new Set<string>();
  for (const match of packed.matchAll(/from\s*["']([^"']+)["']/g)) {
    const specifier = match[1]!;
    if (specifier.startsWith(".")) continue;
    const parts = specifier.split("/");
    found.add(specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!);
  }
  return [...found].sort();
}

describe("specialist pack", () => {
  test("packs every kit role, and nothing else", () => {
    expect(Object.keys(files).sort()).toEqual(AGENT_KIT.map((role) => role.id).sort());
    expect(SPECIALIST_PACK_ROLES.map((role) => role.id).sort()).toEqual(AGENT_KIT.map((role) => role.id).sort());
  });

  test("brainstormer workflow.js is a real defineWorkflow, not a string-built template", () => {
    const source = readFileSync(join(ROOT_DIR, "packages/specialist-brainstormer/src/workflow.ts"), "utf8");
    expect(source).toContain('from "@intx/workflow"');
    expect(source).toContain("defineAgent");
    expect(source).toContain("defineWorkflow");
    const packed = files["brainstormer"]!;
    expect(packed).toContain("defineWorkflow");
    expect(packed).toContain("Interview the problem");
    expect(packed).not.toContain("specialistEntrySource");
    expect(packed).not.toContain("JSON.stringify");
    expect(packed).toContain("inference-source");
    expect(packed).not.toContain("gpt-5.5");
  });

  // #42: a role's package.json declares its tools, and the installer ships
  // what it declares (`specialistTooling`). So every import left in a packed
  // entry must be one the installer knows how to ship and the role declares.
  test("every packed entry imports only declared externals the installer ships, and the tooling agrees", () => {
    for (const role of SPECIALIST_PACK_ROLES) {
      const id = role.id;
      const imports = externalImportsOf(files[id]!);
      const declared = declaredDependencies(role.dir);
      for (const name of imports) {
        expect({ id, name, known: EXTERNAL.includes(name) }).toEqual({ id, name, known: true });
        expect({ id, name, declared: declared.includes(name) }).toEqual({ id, name, declared: true });
      }
      const tooling = specialistTooling(declared);
      expect({ id, tooling }).toEqual({
        id,
        tooling: {
          deck: imports.includes("@solutions-builder/tools-deck"),
          posix: imports.includes("@intx/tools-posix"),
          delivery: imports.includes("@solutions-builder/tools-delivery"),
          artifacts: imports.includes("@corbits/artifacts"),
        },
      });
    }
  });

  // The installer writes both overlays beside every entry; a package that
  // stops importing the guidance would silently drop the workspace's language.
  test("every packed entry imports the model pin and the workspace guidance as overlays", () => {
    for (const [id, packed] of Object.entries(files)) {
      expect({ id, pin: packed.includes('from "./inference-source.js"') }).toEqual({ id, pin: true });
      expect({ id, guidance: packed.includes('from "./workspace-guidance.js"') }).toEqual({ id, guidance: true });
    }
  });

  // A packed entry that changes with the working directory would redeploy every
  // live specialist the first time a build ran from somewhere else.
  test("the packed bytes do not depend on the working directory", async () => {
    const previous = process.cwd();
    process.chdir(join(ROOT_DIR, "apps", "web"));
    try {
      expect(await packSpecialist("specialist-namer")).toBe(files["namer"]!);
    } finally {
      process.chdir(previous);
    }
    expect(process.cwd()).toBe(previous);
  });

  test("only the delivery verifier carries a tool: deliver", () => {
    for (const role of SPECIALIST_PACK_ROLES) {
      const expected = role.id === agentFor(DELIVERY_STAGE).id ? { deck: false, posix: false, delivery: true, artifacts: false } : { deck: false, posix: false, delivery: false, artifacts: false };
      expect({ id: role.id, tooling: specialistTooling(declaredDependencies(role.dir)) }).toEqual({ id: role.id, tooling: expected });
    }
  });

  test("architect workflow.js carries skillTextFor overlay", () => {
    const packed = files["architect"]!;
    expect(packed).toContain("## Skills you carry");
    expect(packed).toContain("what-is-interchange");
    expect(packed).toContain("Interchange is the platform runtime");
  });
});
