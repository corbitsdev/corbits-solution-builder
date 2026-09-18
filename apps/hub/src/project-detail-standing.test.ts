import { describe, expect, test } from "bun:test";

describe("GET /projects/:id standing", () => {
  test("projectDetail returns no run standing; it lets the ledger follow the run and leaves the fold to the client", async () => {
    const source = await Bun.file(new URL("./projects.ts", import.meta.url)).text();
    const detail = source.slice(source.indexOf("export async function projectDetail("));
    expect(detail).not.toContain("standing:");
    expect(detail).not.toContain("activityHeadline");
    expect(detail).toContain("not a second copy of the machine");
    expect(detail).toContain("foldProject");
  });

  test("the host has no submit, decide or commands route; the last host effects moved off it too", async () => {
    const source = await Bun.file(new URL("./api.ts", import.meta.url)).text();
    expect(source).not.toContain('"/projects/:projectId/submit"');
    expect(source).not.toContain('"/projects/:projectId/decide"');
    expect(source).not.toContain('"/projects/:projectId/commands');
    expect(source).not.toContain("api-decisions");
  });
});
