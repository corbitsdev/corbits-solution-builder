import { describe, expect, test } from "bun:test";

describe("GET /projects/:id standing", () => {
  test("projectDetail does not fold a second run standing", async () => {
    const source = await Bun.file(new URL("./projects.ts", import.meta.url)).text();
    expect(source).not.toContain("projectExecutionStatus");
    expect(source).not.toContain("activityHeadline");
    expect(source).toContain("not a second copy of the machine");
    expect(source).toContain("foldProject");
  });

  test("command, submit and decide routes still exist", async () => {
    const source = await Bun.file(new URL("./api-decisions.ts", import.meta.url)).text();
    expect(source).toContain('api.post("/projects/:projectId/commands/:command"');
    expect(source).toContain('api.post("/projects/:projectId/submit"');
    expect(source).toContain('api.post("/projects/:projectId/decide"');
  });
});
