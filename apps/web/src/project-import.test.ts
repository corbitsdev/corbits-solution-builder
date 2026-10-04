import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { bundleAdoptionPlan } from "./bundle-adoption.ts";
import {
  archiveImportPlan,
  importedProjectTitle,
  importArchive,
  importJsonProject,
  jsonFromZip,
  jsonImportPlan,
  readImportPayload,
  IMPORTED_CONVERSATION_KIND,
  type ArchiveImportDeps,
  type ImportWrite,
  type JsonImportDeps,
} from "./project-import.ts";
import { archiveBundle, isArchiveBundle, parseBundle, type ArchiveBundle, type ProjectBundle } from "./project-export.ts";
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

function archive(overrides: Partial<ArchiveBundle> = {}): ArchiveBundle {
  return {
    format: "solutions-builder.project",
    version: 4,
    exportedAt: "2026-01-02T00:00:00.000Z",
    project: { id: "proj_1", title: "Renew the lease", policy: { audiences: [] } },
    artifacts: [{ node: node(), versions: [{ version: 1, content: "the brief" }] }],
    conversations: [
      {
        stage: 1,
        messages: [
          { id: "1", author: "me", body: "What's the deadline?", at: "2026-01-01T00:00:00.000Z" },
          { id: "2", author: "agent", body: "End of quarter.", at: "2026-01-01T00:00:01.000Z" },
        ],
      },
    ],
    workflow: null,
    ...overrides,
  };
}

function jsonBundle(overrides: Partial<ProjectBundle> = {}): ProjectBundle {
  return {
    format: "solutions-builder.project",
    version: 3,
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
    notes: "the workflow's position is carried; the import replays it",
    ...overrides,
  };
}

function archiveDeps(overrides: Partial<ArchiveImportDeps> = {}): ArchiveImportDeps {
  return {
    createProject: async ({ title }) => ({ projectId: `new:${title}` }),
    createArtifact: async (write: ImportWrite) => ({ id: `art:${write.title}`, version: 1 }),
    reviseArtifact: async () => ({ version: 2 }),
    ...overrides,
  };
}

function jsonDeps(overrides: Partial<JsonImportDeps> = {}): JsonImportDeps {
  return {
    createProject: async ({ title }) => ({ projectId: `new:${title}` }),
    createArtifact: async (write: ImportWrite) => ({ id: `art:${write.title}` }),
    ...overrides,
  };
}

describe("importedProjectTitle", () => {
  test("appends (imported)", () => {
    expect(importedProjectTitle(archive())).toBe("Renew the lease (imported)");
  });
});

describe("archiveImportPlan", () => {
  test("re-keys each artifact's sb metadata to the new project, never carrying approvedAt", () => {
    const plan = archiveImportPlan(archive(), "proj_new");
    expect(plan.artifacts).toHaveLength(1);
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
    const plan = archiveImportPlan(
      archive({ artifacts: [{ node: node({ mediaType: "image/png" }), versions: [{ version: 1, content: "data:image/png;base64,AAAA" }] }] }),
      "proj_new",
    );
    expect(plan.artifacts[0]!.versions[0]!.sb["mediaType"]).toBe("image/png");
    expect(plan.artifacts[0]!.versions[0]!.content).toBe("data:image/png;base64,AAAA");
  });

  test("recreates each conversation as one read-only transcript artifact per stage", () => {
    const plan = archiveImportPlan(archive(), "proj_new");
    expect(plan.conversations).toHaveLength(1);
    const write = plan.conversations[0]!;
    expect(write.title).toBe("Problem discovery conversation (imported)");
    expect(write.sb).toMatchObject({ projectId: "proj_new", kind: IMPORTED_CONVERSATION_KIND, stage: 1 });
    expect(write.content).toContain("What's the deadline?");
    expect(write.content).toContain("End of quarter.");
  });

  test("produces no writes for a bundle with no artifacts or conversations", () => {
    const plan = archiveImportPlan(archive({ artifacts: [], conversations: [] }), "proj_new");
    expect(plan.artifacts).toEqual([]);
    expect(plan.conversations).toEqual([]);
  });
});

describe("importArchive", () => {
  test("creates the new project with the imported title and the original policy", async () => {
    const created: { title: string; policy: unknown }[] = [];
    const result = await importArchive(
      archive(),
      archiveDeps({
        createProject: async (input) => {
          created.push(input);
          return { projectId: "proj_new" };
        },
      }),
    );
    expect(created).toEqual([{ title: "Renew the lease (imported)", policy: { audiences: [] } }]);
    expect(result).toMatchObject({ projectId: "proj_new", artifacts: 1, versions: 1, conversations: 1 });
  });

  test("writes every artifact and conversation, and reports progress as it goes", async () => {
    const writes: string[] = [];
    const progress: [number, number][] = [];
    await importArchive(
      archive(),
      archiveDeps({
        createArtifact: async (write) => {
          writes.push(write.title);
          return { id: write.title, version: 1 };
        },
        onProgress: (done, total) => progress.push([done, total]),
      }),
    );
    expect(writes).toEqual(["Problem discovery draft", "Problem discovery conversation (imported)"]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  test("revises in order so a two-version artifact keeps both bodies", async () => {
    const created: string[] = [];
    const revised: string[] = [];
    const two = archive({
      artifacts: [
        {
          node: node({ version: 2 }),
          versions: [
            { version: 1, content: "first" },
            { version: 2, content: "second" },
          ],
        },
      ],
      conversations: [],
    });
    const result = await importArchive(
      two,
      archiveDeps({
        createArtifact: async (write) => {
          created.push(write.content);
          return { id: "written", version: 1 };
        },
        reviseArtifact: async (_id, write) => {
          revised.push(write.content);
          return { version: 2 };
        },
      }),
    );
    expect(created).toEqual(["first"]);
    expect(revised).toEqual(["second"]);
    expect(result.versions).toBe(2);
  });

  test("a zip with no workflow still plans from heads, the way JSON does", async () => {
    const result = await importArchive(
      archive({
        artifacts: [
          { node: node({ id: "brief", kind: "problem_brief", stage: 1, artifactId: "art_brief" }), versions: [{ version: 1, content: "the brief" }] },
          {
            node: node({
              id: "cons",
              kind: "solution_constraints",
              stage: 2,
              title: "Constraints",
              artifactId: "art_cons",
              createdAt: "2026-01-02T00:00:00.000Z",
            }),
            versions: [{ version: 1, content: "the constraints" }],
          },
        ],
        conversations: [],
        workflow: null,
      }),
      archiveDeps({
        createProject: async () => ({ projectId: "proj_new" }),
        createArtifact: async (write) => ({ id: `new:${write.title}`, version: 1 }),
      }),
    );
    expect(result.plan.legacyStage).toBe(2);
    expect(result.plan.steps.map((step) => step.stage)).toEqual([1]);
    expect(result.plan.steps[0]!.ref.artifactId).toBe("new:Problem discovery draft");
    expect(result.plan.steps[0]!.ref.version).toBe(1);
  });

  test("a zip with a recorded workflow replays that record, not heads", async () => {
    const result = await importArchive(
      archive({
        artifacts: [
          { node: node({ id: "brief", kind: "problem_brief", stage: 1, artifactId: "art_brief" }), versions: [{ version: 1, content: "the brief" }] },
          {
            node: node({
              id: "cons",
              kind: "solution_constraints",
              stage: 2,
              title: "Constraints",
              artifactId: "art_cons",
              createdAt: "2026-01-02T00:00:00.000Z",
            }),
            versions: [{ version: 1, content: "the constraints" }],
          },
        ],
        conversations: [],
        workflow: {
          stage: 1,
          done: false,
          reviews: {},
          decisions: [],
          votes: {},
          freeze: null,
          audiencePackages: {},
          requirements: [],
        },
      }),
      archiveDeps({
        createProject: async () => ({ projectId: "proj_new" }),
        createArtifact: async (write) => ({ id: `new:${write.title}`, version: 1 }),
      }),
    );
    expect(result.plan.legacyStage).toBe(1);
    expect(result.plan.steps).toEqual([]);
  });
});

describe("a main v3 JSON bundle", () => {
  test("still parses as one-content JSON and plans through bundleAdoptionPlan", () => {
    const raw = jsonBundle({
      workflow: {
        stage: 2,
        done: false,
        decisions: [{ kind: "approve", stage: 1, artifactId: "art_1", version: 1, sha256: "sha-brief" }],
        audienceDecisions: {},
        freeze: null,
      },
    });
    const parsed = parseBundle(raw);
    expect(isArchiveBundle(parsed)).toBe(false);
    if (isArchiveBundle(parsed)) throw new Error("expected JSON");
    const plan = jsonImportPlan(parsed, "proj_new");
    expect(plan.artifacts).toHaveLength(1);
    expect(plan.artifacts[0]!.content).toBe("the brief");
    const ids = new Map([["node_1", "new-brief"]]);
    const digests = new Map([["node_1", "sha-brief"]]);
    const adoption = bundleAdoptionPlan(parsed, "proj_new", ids, digests);
    expect(adoption.steps.map((step) => step.stage)).toEqual([1]);
    expect(adoption.steps[0]!.ref).toEqual({ artifactId: "new-brief", version: 1, sha256: "sha-brief" });
  });

  test("imports with one create per artifact and never revises", async () => {
    const result = await importJsonProject(
      jsonBundle(),
      jsonDeps({
        createProject: async () => ({ projectId: "proj_json" }),
        createArtifact: async (write) => ({ id: `art:${write.title}` }),
      }),
    );
    expect(result).toEqual({
      projectId: "proj_json",
      artifacts: 1,
      conversations: 1,
      ids: new Map([["node_1", "art:Problem discovery draft"]]),
    });
  });
});

describe("readImportPayload", () => {
  test("parses a .json file as the bundle object", async () => {
    const payload = jsonBundle();
    const file = new File([JSON.stringify(payload)], "renew-the-lease.solutions-builder.json", { type: "application/json" });
    expect(await readImportPayload(file)).toEqual(payload);
  });

  test("unpacks a zip with one json (plus other files) and imports that bundle", async () => {
    const payload = jsonBundle();
    const zip = new JSZip();
    zip.file("README.txt", "not the bundle");
    zip.file("export/renew-the-lease.solutions-builder.json", JSON.stringify(payload));
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const file = new File([bytes], "renew-the-lease.zip", { type: "application/zip" });
    const raw = await readImportPayload(file);
    expect(raw).toEqual(payload);
    const parsed = parseBundle(raw);
    expect(isArchiveBundle(parsed)).toBe(false);
    if (isArchiveBundle(parsed)) throw new Error("expected JSON");
    const result = await importJsonProject(
      parsed,
      jsonDeps({
        createProject: async () => ({ projectId: "proj_from_zip" }),
      }),
    );
    expect(result).toEqual({ projectId: "proj_from_zip", artifacts: 1, conversations: 1, ids: new Map([["node_1", "art:Problem discovery draft"]]) });
  });

  test("a v4 zip hydrates version files, including gzip as a data URL rebuilt from bytes", async () => {
    const gzipBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
    const content = `data:application/gzip;base64,${btoa(String.fromCharCode(...gzipBytes))}`;
    const packed = archive({
      artifacts: [
        {
          node: node({ id: "build_1", kind: "build_evidence", variant: "1", stage: 8, title: "Build", mediaType: "application/gzip", artifactId: "build_1" }),
          versions: [{ version: 1, content }],
        },
      ],
      conversations: [],
    });
    const bytes = await archiveBundle(packed).generateAsync({ type: "uint8array" });
    const raw = await jsonFromZip(bytes, "export.zip");
    const parsed = parseBundle(raw);
    expect(isArchiveBundle(parsed)).toBe(true);
    if (!isArchiveBundle(parsed)) throw new Error("expected archive");
    expect(parsed.artifacts[0]?.versions[0]?.content.startsWith("data:application/gzip;base64,")).toBe(true);
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
    const payload = jsonBundle();
    const zip = new JSZip();
    zip.file("renew.json", JSON.stringify(payload));
    zip.file("__MACOSX/._renew.json", "junk");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await jsonFromZip(bytes, "mac.zip")).toEqual(payload);
  });
});
