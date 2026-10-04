import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpecialistWorkflowFiles, ROOT_DIR, SPECIALIST_PACK_ROLES } from "./specialist-pack.ts";

const files = await buildSpecialistWorkflowFiles();

describe("specialist pack", () => {
  test("packs every role package", () => {
    expect(Object.keys(files).sort()).toEqual(SPECIALIST_PACK_ROLES.map((role) => role.id).sort());
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

  test("delivery verifier keeps the deliver tool as an external import", () => {
    const packed = files["delivery-verifier"]!;
    expect(packed).toContain("@solutions-builder/tools-delivery");
    expect(packed).toContain("defineWorkflow");
  });
});
