import { describe, expect, test } from "bun:test";
import { openCreatedProject } from "./create-project-open.ts";

describe("openCreatedProject", () => {
  test("a failed open conceals that tenant and does not mint another", async () => {
    const concealed: string[] = [];
    const opened: string[] = [];
    await expect(
      openCreatedProject({
        projectId: "project-1",
        open: async () => {
          opened.push("project-1");
          throw new Error("the host would not open the run");
        },
        conceal: async (projectId) => {
          concealed.push(projectId);
        },
      }),
    ).rejects.toThrow("the host would not open the run");
    expect(opened).toEqual(["project-1"]);
    expect(concealed).toEqual(["project-1"]);
  });

  test("a retryable open failure retries the same project id then conceals", async () => {
    const concealed: string[] = [];
    const opened: string[] = [];
    await expect(
      openCreatedProject({
        projectId: "project-1",
        open: async () => {
          opened.push("project-1");
          throw new Error("dropped");
        },
        conceal: async (projectId) => {
          concealed.push(projectId);
        },
        retryable: () => true,
      }),
    ).rejects.toThrow("dropped");
    expect(opened).toEqual(["project-1", "project-1"]);
    expect(concealed).toEqual(["project-1"]);
  });

  test("a retryable open failure that then succeeds keeps the tenant", async () => {
    const concealed: string[] = [];
    let attempts = 0;
    const opened = await openCreatedProject({
      projectId: "project-1",
      open: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("dropped");
        return { projectId: "project-1", runId: "run-1" };
      },
      conceal: async (projectId) => {
        concealed.push(projectId);
      },
      retryable: () => true,
    });
    expect(opened).toEqual({ projectId: "project-1", runId: "run-1" });
    expect(concealed).toEqual([]);
  });
});
