import { describe, expect, test } from "bun:test";
import { importedProjectTitle, importPlan, importProject, IMPORTED_CONVERSATION_KIND, type ImportDeps, type ImportWrite } from "./project-import.ts";
import type { ProjectBundle } from "./project-export.ts";
import type { ArtifactNode } from "./client.ts";

function node(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "node_1",
    kind: "problem_brief",
    variant: null,
    stage: 1,
    title: "Stage 1 draft",
    version: 1,
    artifactId: "art_1",
    contentHash: "node_1@1",
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent", agentRole: "specialist" },
    approvedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function bundle(overrides: Partial<ProjectBundle> = {}): ProjectBundle {
  return {
    format: "solutions-builder.project",
    version: 2,
    exportedAt: "2026-01-02T00:00:00.000Z",
    project: { id: "proj_1", title: "Renew the lease", policy: { audiences: [] } },
    artifacts: [{ node: node(), content: "the brief" }],
    conversations: [
      {
        stage: 1,
        messages: [
          { id: "1", author: "me", body: "What's the deadline?", at: "2026-01-01T00:00:00.000Z" },
          { id: "2", author: "agent", body: "End of quarter.", at: "2026-01-01T00:00:01.000Z" },
        ],
      },
    ],
    notes: "workflow events are not included yet",
    ...overrides,
  };
}

describe("importedProjectTitle", () => {
  test("appends (imported)", () => {
    expect(importedProjectTitle(bundle())).toBe("Renew the lease (imported)");
  });
});

describe("importPlan", () => {
  test("re-keys each artifact's sb metadata to the new project, never carrying approvedAt", () => {
    const plan = importPlan(bundle(), "proj_new");
    expect(plan.artifacts).toHaveLength(1);
    const write = plan.artifacts[0]!;
    expect(write.title).toBe("Stage 1 draft");
    expect(write.content).toBe("the brief");
    expect(write.sb).toEqual({
      projectId: "proj_new",
      kind: "problem_brief",
      stage: 1,
      variant: null,
      sourceVersionIds: [],
      provenance: { producer: "agent", agentRole: "specialist" },
    });
    expect(write.sb).not.toHaveProperty("approvedAt");
  });

  test("keeps a mediaType when the original node had one", () => {
    const plan = importPlan(bundle({ artifacts: [{ node: node({ mediaType: "image/png" }), content: "data:image/png;base64,AAAA" }] }), "proj_new");
    expect(plan.artifacts[0]!.sb["mediaType"]).toBe("image/png");
    expect(plan.artifacts[0]!.content).toBe("data:image/png;base64,AAAA");
  });

  test("recreates each conversation as one read-only transcript artifact per stage", () => {
    const plan = importPlan(bundle(), "proj_new");
    expect(plan.conversations).toHaveLength(1);
    const write = plan.conversations[0]!;
    expect(write.title).toBe("Stage 1 conversation (imported)");
    expect(write.sb).toMatchObject({ projectId: "proj_new", kind: IMPORTED_CONVERSATION_KIND, stage: 1 });
    expect(write.content).toContain("What's the deadline?");
    expect(write.content).toContain("End of quarter.");
  });

  test("produces no writes for a bundle with no artifacts or conversations", () => {
    const plan = importPlan(bundle({ artifacts: [], conversations: [] }), "proj_new");
    expect(plan.artifacts).toEqual([]);
    expect(plan.conversations).toEqual([]);
  });
});

describe("importProject", () => {
  function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
    return {
      createProject: async ({ title }) => ({ projectId: `new:${title}` }),
      createArtifact: async (write: ImportWrite) => ({ id: `art:${write.title}` }),
      ...overrides,
    };
  }

  test("creates the new project with the imported title and the original policy", async () => {
    const created: { title: string; policy: unknown }[] = [];
    const result = await importProject(
      bundle(),
      deps({
        createProject: async (input) => {
          created.push(input);
          return { projectId: "proj_new" };
        },
      }),
    );
    expect(created).toEqual([{ title: "Renew the lease (imported)", policy: { audiences: [] } }]);
    expect(result).toEqual({ projectId: "proj_new", artifacts: 1, conversations: 1 });
  });

  test("writes every artifact and conversation, and reports progress as it goes", async () => {
    const writes: string[] = [];
    const progress: [number, number][] = [];
    await importProject(
      bundle(),
      deps({
        createArtifact: async (write) => {
          writes.push(write.title);
          return { id: write.title };
        },
        onProgress: (done, total) => progress.push([done, total]),
      }),
    );
    expect(writes).toEqual(["Stage 1 draft", "Stage 1 conversation (imported)"]);
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });
});
