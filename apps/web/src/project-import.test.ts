import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { importedProjectTitle, importPlan, importProject, jsonFromZip, readImportPayload, IMPORTED_CONVERSATION_KIND, type ImportDeps, type ImportWrite } from "./project-import.ts";
import { parseBundle, type ProjectBundle } from "./project-export.ts";
import type { ArtifactNode } from "./client.ts";

function node(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "node_1",
    kind: "problem_brief",
    variant: null,
    stage: 1,
    title: "Problem discovery draft",
    version: 1,
    position: 1,
    artifactId: "art_1",
    contentHash: "node_1@1",
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent", agentRole: "specialist" },
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

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    createProject: async ({ title }) => ({ projectId: `new:${title}` }),
    createArtifact: async (write: ImportWrite) => ({ id: `art:${write.title}`, version: 1 }),
    reviseArtifact: async () => ({ version: 2 }),
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
    expect(plan.artifacts[0]!.nodeId).toBe("node_1");
    expect(plan.artifacts[0]!.versions).toHaveLength(1);
    const write = plan.artifacts[0]!.versions[0]!;
    expect(write.title).toBe("Problem discovery draft");
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
    expect(plan.artifacts[0]!.versions[0]!.sb["mediaType"]).toBe("image/png");
    expect(plan.artifacts[0]!.versions[0]!.content).toBe("data:image/png;base64,AAAA");
  });

  // #632: a v4 bundle's version chain becomes one write per version, oldest first.
  test("plans one write per bundled version, oldest first, whatever order the bundle listed them in", () => {
    const plan = importPlan(
      bundle({
        version: 4,
        artifacts: [
          {
            node: node({ version: 3 }),
            content: "third",
            versions: [
              { version: 3, content: "third" },
              { version: 1, content: "first" },
              { version: 2, content: "second" },
            ],
          },
        ],
      }),
      "proj_new",
    );
    expect(plan.artifacts[0]!.versions.map((write) => write.content)).toEqual(["first", "second", "third"]);
    for (const write of plan.artifacts[0]!.versions) {
      expect(write.title).toBe("Problem discovery draft");
      expect(write.sb).toMatchObject({ projectId: "proj_new", kind: "problem_brief", stage: 1, sourceVersionIds: [] });
    }
  });

  test("an artifact with an empty versions array is written once, from its content", () => {
    const plan = importPlan(bundle({ version: 4, artifacts: [{ node: node(), content: "the brief", versions: [] }] }), "proj_new");
    expect(plan.artifacts[0]!.versions.map((write) => write.content)).toEqual(["the brief"]);
  });

  test("recreates each conversation as one read-only transcript artifact per stage", () => {
    const plan = importPlan(bundle(), "proj_new");
    expect(plan.conversations).toHaveLength(1);
    const write = plan.conversations[0]!;
    expect(write.title).toBe("Problem discovery conversation (imported)");
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
    expect(result).toEqual({
      projectId: "proj_new",
      artifacts: 1,
      versions: 1,
      conversations: 1,
      written: new Map([["node_1", { artifactId: "art:Problem discovery draft", version: 1 }]]),
    });
  });

  // #632: the chain is created then revised in order, and the node is reported at the version the store gave its last write.
  test("creates the first version, revises the rest in order, and reports where each node landed", async () => {
    const writes: string[] = [];
    const progress: [number, number][] = [];
    const result = await importProject(
      bundle({
        version: 4,
        artifacts: [
          { node: node({ id: "node_a", version: 3 }), content: "a3", versions: [{ version: 1, content: "a1" }, { version: 2, content: "a2" }, { version: 3, content: "a3" }] },
          { node: node({ id: "node_b", title: "Solution shape draft" }), content: "b1", versions: [{ version: 1, content: "b1" }] },
        ],
      }),
      deps({
        createArtifact: async (write) => {
          writes.push(write.sb["kind"] === IMPORTED_CONVERSATION_KIND ? `create ${write.title}` : `create ${write.content}`);
          return { id: `art:${write.content}`, version: 1 };
        },
        reviseArtifact: async (artifactId, write) => {
          writes.push(`revise ${artifactId} ${write.content}`);
          return { version: Number(write.content.slice(1)) };
        },
        onProgress: (done, total) => progress.push([done, total]),
      }),
    );
    expect(writes).toEqual(["create a1", "revise art:a1 a2", "revise art:a1 a3", "create b1", "create Problem discovery conversation (imported)"]);
    expect(progress).toEqual([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]);
    expect(result.artifacts).toBe(2);
    expect(result.versions).toBe(4);
    expect(result.written).toEqual(
      new Map([
        ["node_a", { artifactId: "art:a1", version: 3 }],
        ["node_b", { artifactId: "art:b1", version: 1 }],
      ]),
    );
  });

  test("writes every artifact and conversation, and reports progress as it goes", async () => {
    const writes: string[] = [];
    const progress: [number, number][] = [];
    await importProject(
      bundle(),
      deps({
        createArtifact: async (write) => {
          writes.push(write.title);
          return { id: write.title, version: 1 };
        },
        onProgress: (done, total) => progress.push([done, total]),
      }),
    );
    expect(writes).toEqual(["Problem discovery draft", "Problem discovery conversation (imported)"]);
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });
});

describe("readImportPayload", () => {
  test("parses a .json file as the bundle object", async () => {
    const payload = bundle();
    const file = new File([JSON.stringify(payload)], "renew-the-lease.solutions-builder.json", { type: "application/json" });
    expect(await readImportPayload(file)).toEqual(payload);
  });

  test("unpacks a zip with one json (plus other files) and imports that bundle", async () => {
    const payload = bundle();
    const zip = new JSZip();
    zip.file("README.txt", "not the bundle");
    zip.file("export/renew-the-lease.solutions-builder.json", JSON.stringify(payload));
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const file = new File([bytes], "renew-the-lease.zip", { type: "application/zip" });
    const raw = await readImportPayload(file);
    expect(raw).toEqual(payload);
    const result = await importProject(
      parseBundle(raw),
      deps({
        createProject: async () => ({ projectId: "proj_from_zip" }),
      }),
    );
    expect(result).toEqual({
      projectId: "proj_from_zip",
      artifacts: 1,
      versions: 1,
      conversations: 1,
      written: new Map([["node_1", { artifactId: "art:Problem discovery draft", version: 1 }]]),
    });
  });
});

describe("jsonFromZip", () => {
  test("rejects a zip with no json", async () => {
    const zip = new JSZip();
    zip.file("notes.txt", "hello");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(jsonFromZip(bytes, "empty.zip")).rejects.toThrow(/no JSON bundle inside/);
  });

  test("rejects a zip with more than one json", async () => {
    const zip = new JSZip();
    zip.file("a.json", "{}");
    zip.file("b.json", "{}");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(jsonFromZip(bytes, "two.zip")).rejects.toThrow(/more than one JSON file/);
  });

  test("ignores macOS junk json so a real bundle still counts as one", async () => {
    const payload = bundle();
    const zip = new JSZip();
    zip.file("renew.json", JSON.stringify(payload));
    zip.file("__MACOSX/._renew.json", "junk");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await jsonFromZip(bytes, "mac.zip")).toEqual(payload);
  });
});

