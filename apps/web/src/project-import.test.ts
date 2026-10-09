import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { foldArtifactGraph, type ArtifactListEntry } from "@solutions-builder/app/artifact-graph";
import { importedProjectTitle, importPlan, importProject, jsonFromZip, readImportPayload, writeOrder, IMPORTED_CONVERSATION_KIND, type ImportDeps, type ImportWrite } from "./project-import.ts";
import { parseBundle, type ExportedArtifact, type ProjectBundle } from "./project-export.ts";
import { artifactNodesOf } from "./project-view.ts";
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

// #632: a lineage comes back as a lineage, not as so many roots. A saved
// draft is a new artifact at version 1, so what a person sees as the version
// number is the node's position, derived from `sb.supersedes`.
describe("restoring a lineage", () => {
  const at = (n: number) => `2026-01-0${String(n)}T00:00:00.000Z`;
  function lineage(): ExportedArtifact[] {
    return [
      { node: node({ id: "v3", createdAt: at(3) }), content: "third", sources: ["v2", "brief"] },
      { node: node({ id: "v1", createdAt: at(1), supersededByNodeId: "v2" }), content: "first", sources: [] },
      { node: node({ id: "brief", kind: "source_material", createdAt: at(1) }), content: "the pdf", sources: [] },
      { node: node({ id: "v2", createdAt: at(2), supersededByNodeId: "v3" }), content: "second", sources: ["v1"] },
    ];
  }

  /** A store that keeps what was written, for the graph fold to read back the way `projectView` would. */
  function store() {
    const entries: ArtifactListEntry[] = [];
    let tick = 0;
    const deps: ImportDeps = {
      createProject: async () => ({ projectId: "proj_new" }),
      createArtifact: async (write) => {
        tick += 1;
        const id = `new:${write.content}`;
        entries.push({ id, version: 1, title: write.title, createdAt: `2026-02-01T00:00:${String(tick).padStart(2, "0")}.000Z`, metadata: { sb: write.sb } });
        return { id, version: 1 };
      },
      reviseArtifact: async (artifactId, write) => {
        const entry = entries.find((candidate) => candidate.id === artifactId)!;
        entry.version += 1;
        entry.metadata = { sb: write.sb };
        return { version: entry.version };
      },
    };
    return { entries, deps };
  }

  test("writes a node after the one it supersedes and the ones it was generated from, oldest first otherwise", () => {
    expect(writeOrder(lineage()).map(({ node }) => node.id)).toEqual(["v1", "brief", "v2", "v3"]);
    const plan = importPlan(bundle({ version: 4, artifacts: lineage() }), "proj_new");
    expect(plan.artifacts.map(({ nodeId, supersedes, sources }) => [nodeId, supersedes, sources])).toEqual([
      ["v1", null, []],
      ["brief", null, []],
      ["v2", "v1", ["v1"]],
      ["v3", "v2", ["v2", "brief"]],
    ]);
  });

  test("a three-node lineage imports as positions 1, 2 and 3 with only the head unsuperseded, linked to what it was written from", async () => {
    const { entries, deps } = store();
    await importProject(bundle({ version: 4, artifacts: lineage(), conversations: [] }), deps);
    const graph = foldArtifactGraph(entries, "proj_new");
    const nodes = artifactNodesOf(graph.nodes);
    const drafts = nodes.filter((entry) => entry.kind === "problem_brief").sort((a, b) => a.position - b.position);
    expect(drafts.map((entry) => [entry.id, entry.position, entry.supersededByNodeId])).toEqual([
      ["new:first", 1, "new:second"],
      ["new:second", 2, "new:third"],
      ["new:third", 3, null],
    ]);
    expect(graph.edges).toEqual([
      { childNodeId: "new:second", sourceNodeId: "new:first" },
      { childNodeId: "new:third", sourceNodeId: "new:second" },
      { childNodeId: "new:third", sourceNodeId: "new:the pdf" },
    ]);
    expect(entries.find((entry) => entry.id === "new:third")?.metadata).toEqual({
      sb: expect.objectContaining({ supersedes: "new:second", sourceVersionIds: ["new:second@1", "new:the pdf@1"] }),
    });
    expect(entries.find((entry) => entry.id === "new:first")?.metadata).toEqual({ sb: expect.not.objectContaining({ supersedes: expect.anything() }) });
  });

  test("every version of a chained artifact carries the lineage, at the source's landed version", async () => {
    const { entries, deps } = store();
    await importProject(
      bundle({
        version: 4,
        conversations: [],
        artifacts: [
          { node: node({ id: "a", createdAt: at(1), supersededByNodeId: "b", version: 2 }), content: "a2", versions: [{ version: 1, content: "a1" }, { version: 2, content: "a2" }], sources: [] },
          { node: node({ id: "b", createdAt: at(2) }), content: "b", sources: ["a"] },
        ],
      }),
      deps,
    );
    expect(entries.find((entry) => entry.id === "new:b")?.metadata).toEqual({ sb: expect.objectContaining({ supersedes: "new:a1", sourceVersionIds: ["new:a1@2"] }) });
  });

  test("a node whose predecessor or source is not in the bundle is a root", async () => {
    const { entries, deps } = store();
    await importProject(
      bundle({
        version: 4,
        conversations: [],
        artifacts: [{ node: node({ id: "v2", createdAt: at(2) }), content: "second", sources: ["gone"] }, { node: node({ id: "v1", createdAt: at(1), supersededByNodeId: "pruned" }), content: "first" }],
      }),
      deps,
    );
    const nodes = artifactNodesOf(foldArtifactGraph(entries, "proj_new").nodes);
    expect(nodes.map((entry) => [entry.id, entry.position, entry.supersededByNodeId])).toEqual([
      ["new:first", 1, null],
      ["new:second", 2, null],
    ]);
    expect(entries.map((entry) => (entry.metadata as { sb: { sourceVersionIds: string[] } }).sb.sourceVersionIds)).toEqual([[], []]);
  });

  test("a cycle is broken at the oldest node, which becomes a root, and still writes every node once", async () => {
    const { entries, deps } = store();
    const artifacts: ExportedArtifact[] = [
      { node: node({ id: "x", createdAt: at(1), supersededByNodeId: "y" }), content: "x", sources: ["y"] },
      { node: node({ id: "y", createdAt: at(2), supersededByNodeId: "x" }), content: "y", sources: [] },
    ];
    expect(writeOrder(artifacts).map(({ node }) => node.id)).toEqual(["x", "y"]);
    const result = await importProject(bundle({ version: 4, artifacts, conversations: [] }), deps);
    expect(result.artifacts).toBe(2);
    expect(entries.map((entry) => [entry.id, (entry.metadata as { sb: Record<string, unknown> }).sb["supersedes"] ?? null])).toEqual([
      ["new:x", null],
      ["new:y", "new:x"],
    ]);
  });

  test("a v2 bundle, which carries no sources, still links a lineage from supersededByNodeId", () => {
    const plan = importPlan(
      bundle({ artifacts: [{ node: node({ id: "old", createdAt: at(1), supersededByNodeId: "new" }), content: "old" }, { node: node({ id: "new", createdAt: at(2) }), content: "new" }] }),
      "proj_new",
    );
    expect(plan.artifacts.map(({ nodeId, supersedes, sources }) => [nodeId, supersedes, sources])).toEqual([
      ["old", null, []],
      ["new", "old", []],
    ]);
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

