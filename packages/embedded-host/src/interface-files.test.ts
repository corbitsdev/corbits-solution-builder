import { describe, expect, test } from "bun:test";
import { asksForInterfaceFile, missingInterfaceFile } from "./interface-files.js";

describe("interface file requests", () => {
  test("a path with a file extension asks for a file", () => {
    expect(asksForInterfaceFile("/closure/manifest.json")).toBe(true);
    expect(asksForInterfaceFile("/project-workflow/workflow.js")).toBe(true);
    expect(asksForInterfaceFile("/assets/index-abc123.css")).toBe(true);
  });

  test("a path without one is a route of the app", () => {
    expect(asksForInterfaceFile("/")).toBe(false);
    expect(asksForInterfaceFile("/projects")).toBe(false);
    expect(asksForInterfaceFile("/projects/prj_1")).toBe(false);
  });

  test("the missing-file answer names the file and the build", () => {
    expect(missingInterfaceFile("/closure/manifest.json", "bun run ui:build")).toBe(
      "/closure/manifest.json is not in the built interface. Run `bun run ui:build` to produce it.",
    );
  });
});
