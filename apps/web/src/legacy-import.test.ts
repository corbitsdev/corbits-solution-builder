import { describe, expect, test } from "bun:test";
import { IMPORTED_CONVERSATION_KIND, type ImportWrite } from "./project-import.ts";
import {
  importLegacyProject,
  isLegacyBundle,
  legacyAdoptionPlan,
  legacyImportPlan,
  parseLegacyBundle,
  type LegacyBundle,
  type LegacyBundleNode,
  type LegacyImportDeps,
} from "./legacy-import.ts";

function node(overrides: Partial<LegacyBundleNode> = {}): LegacyBundleNode {
  return {
    id: "nod_brief_1",
    artifactId: "brief",
    version: 1,
    kind: "problem_brief",
    variant: null,
    stage: 1,
    title: "Brainstormer — stage 1",
    mediaType: "text/markdown",
    contentHash: "hash_brief_1",
    provenance: { producer: "agent", agentRole: "brainstormer", runId: "run_1", promptKey: "sb-prompt-brainstormer-v1", assumptions: ["dropped"] },
    supersededByNodeId: null,
    createdAt: "2026-09-17T21:51:35.000Z",
    content: "the brief, first draft",
    ...overrides,
  };
}

/** A project approved through stage 2: a brief revised once, constraints drawn from the approved brief. */
const NODES: LegacyBundleNode[] = [
  node(),
  node({ id: "nod_brief_2", version: 2, contentHash: "hash_brief_2", createdAt: "2026-09-17T22:00:00.000Z", content: "the brief, approved" }),
  node({
    id: "nod_constraints_1",
    artifactId: "constraints",
    kind: "solution_constraints",
    stage: 2,
    title: "Constraints — stage 2",
    contentHash: "hash_constraints_1",
    createdAt: "2026-09-17T22:10:00.000Z",
    content: "the constraints",
    provenance: { producer: "agent", agentRole: "constraints-analyst" },
  }),
];

function bundle(overrides: Partial<LegacyBundle> = {}): LegacyBundle {
  return {
    format: "solutions-builder.project",
    version: 1,
    exportedAt: "2026-09-23T00:00:00.000Z",
    project: { id: "tnt_old", title: "Snooker Match", policy: { audiences: [{ name: "You", role: "project_owner" }], audienceQuorum: 1 } },
    ledger: [
      { startedAt: "1", metadata: { command: "project.create", stage: 1, after: { stage: 1, state: "in_progress" } } },
      { startedAt: "2", metadata: { command: "stage.approve", stage: 1, decision: "approve", versions: [{ versionId: "nod_brief_2", artifactId: "brief", contentHash: "hash_brief_2" }], after: { stage: 2, state: "in_progress" } } },
      { startedAt: "3", metadata: { command: "stage.approve", stage: 2, decision: "approve", versions: [{ versionId: "nod_constraints_1", artifactId: "constraints", contentHash: "hash_constraints_1" }], after: { stage: 3, state: "in_progress" } } },
    ],
    artifacts: { nodes: NODES, edges: [{ childNodeId: "nod_constraints_1", sourceNodeId: "nod_brief_2" }] },
    conversations: [
      {
        stage: 1,
        turns: [
          { id: "t1", role: "specialist", body: "What is the deadline?", createdAt: "2026-09-17T21:51:33.000Z" },
          { id: "t2", role: "human", body: "End of quarter.", createdAt: "2026-09-17T21:52:00.000Z" },
        ],
      },
      { stage: 2, turns: [] },
    ],
    ...overrides,
  };
}

/** An artifact store that numbers versions the way the real one does. */
function store() {
  const artifacts = new Map<string, { title: string; versions: ImportWrite[] }>();
  const deps: LegacyImportDeps = {
    createProject: async ({ title }) => ({ projectId: `new:${title}` }),
    createArtifact: async (write) => {
      const id = `art_${String(artifacts.size + 1)}`;
      artifacts.set(id, { title: write.title, versions: [write] });
      return { id, version: 1 };
    },
    reviseArtifact: async (artifactId, write) => {
      const artifact = artifacts.get(artifactId);
      if (!artifact) throw new Error(`no artifact ${artifactId}`);
      artifact.versions.push(write);
      return { version: artifact.versions.length };
    },
  };
  return { deps, artifacts };
}

describe("isLegacyBundle / parseLegacyBundle", () => {
  test("recognizes a version 1 bundle and nothing else", () => {
    expect(isLegacyBundle(bundle())).toBe(true);
    expect(isLegacyBundle({ ...bundle(), version: 2 })).toBe(false);
    expect(isLegacyBundle({ format: "other", version: 1 })).toBe(false);
    expect(isLegacyBundle(null)).toBe(false);
  });

  test("parses a real bundle back to itself, dropping fields it does not carry", () => {
    const parsed = parseLegacyBundle(JSON.parse(JSON.stringify(bundle())));
    expect(parsed.project).toEqual(bundle().project);
    expect(parsed.artifacts.nodes.map((entry) => entry.id)).toEqual(["nod_brief_1", "nod_brief_2", "nod_constraints_1"]);
    expect(parsed.ledger.map((entry) => entry.metadata.command)).toEqual(["project.create", "stage.approve", "stage.approve"]);
    expect(parsed.conversations[0]!.turns[1]).toEqual({ id: "t2", role: "human", body: "End of quarter.", createdAt: "2026-09-17T21:52:00.000Z" });
  });

  test("names what is wrong", () => {
    expect(() => parseLegacyBundle({ ...bundle(), version: 3 })).toThrow("unsupported project bundle version: 3");
    expect(() => parseLegacyBundle({ ...bundle(), ledger: undefined })).toThrow("project bundle is missing ledger");
    expect(() => parseLegacyBundle({ ...bundle(), artifacts: { nodes: [{ id: "x" }], edges: [] } })).toThrow("artifact node 0 is missing artifactId");
    expect(() => parseLegacyBundle({ ...bundle(), ledger: [{ metadata: {} }] })).toThrow("ledger entry 0 is missing its command");
  });
});

describe("legacyImportPlan", () => {
  test("writes every version oldest first, each with the graph metadata its node row described", () => {
    const plan = legacyImportPlan(bundle(), "proj_new");
    expect(plan.versions.map((write) => [write.artifactKey, write.version])).toEqual([
      ["brief", 1],
      ["brief", 2],
      ["constraints", 1],
    ]);
    expect(plan.versions[0]!.sb).toEqual({
      projectId: "proj_new",
      kind: "problem_brief",
      stage: 1,
      provenance: { producer: "agent", agentRole: "brainstormer", runId: "run_1", promptKey: "sb-prompt-brainstormer-v1" },
      mediaType: "text/markdown",
    });
    expect(plan.versions[2]!.sources).toEqual([{ artifactKey: "brief", version: 2 }]);
    expect(plan.versions[2]!.content).toBe("the constraints");
  });

  test("keeps a data: URL for a binary original as it was bundled", () => {
    const deck = node({ id: "nod_deck", artifactId: "deck", kind: "audience_deck", stage: 5, mediaType: "application/vnd.ms-powerpoint", content: "data:application/vnd.ms-powerpoint;base64,AAAA" });
    const plan = legacyImportPlan(bundle({ artifacts: { nodes: [deck], edges: [] } }), "proj_new");
    expect(plan.versions[0]!.content).toBe("data:application/vnd.ms-powerpoint;base64,AAAA");
    expect(plan.versions[0]!.sb.mediaType).toBe("application/vnd.ms-powerpoint");
  });

  test("names the artifact a node superseded when the successor is another artifact", () => {
    const old = node({ id: "nod_old", artifactId: "old", supersededByNodeId: "nod_new", createdAt: "2026-09-17T21:00:00.000Z" });
    const replacement = node({ id: "nod_new", artifactId: "new", createdAt: "2026-09-17T21:30:00.000Z" });
    const plan = legacyImportPlan(bundle({ artifacts: { nodes: [replacement, old], edges: [] } }), "proj_new");
    expect(plan.versions.map((write) => [write.artifactKey, write.supersedes])).toEqual([
      ["old", null],
      ["new", "old"],
    ]);
  });

  test("refuses a version numbering the store could not reproduce", () => {
    const skipped = node({ id: "nod_brief_3", version: 3, createdAt: "2026-09-17T23:00:00.000Z" });
    expect(() => legacyImportPlan(bundle({ artifacts: { nodes: [node(), skipped], edges: [] } }), "proj_new")).toThrow("has version 3 where version 2 was expected");
  });

  test("turns each stage's turns into one transcript, and skips a stage with none", () => {
    const plan = legacyImportPlan(bundle(), "proj_new");
    expect(plan.conversations).toHaveLength(1);
    const write = plan.conversations[0]!;
    expect(write.title).toBe("Stage 1 conversation (imported)");
    expect(write.sb).toMatchObject({ projectId: "proj_new", kind: IMPORTED_CONVERSATION_KIND, stage: 1 });
    expect(write.content).toContain("**Specialist** — 2026-09-17T21:51:33.000Z\n\nWhat is the deadline?");
    expect(write.content).toContain("**You** — 2026-09-17T21:52:00.000Z\n\nEnd of quarter.");
  });
});

describe("legacyAdoptionPlan", () => {
  test("points each stage's approval at the artifact written here, keeping the version and the digest", () => {
    const plan = legacyAdoptionPlan(bundle(), "proj_new", new Map([["brief", "art_1"], ["constraints", "art_2"]]));
    expect(plan.legacyStage).toBe(3);
    expect(plan.steps.map((step) => step.ref)).toEqual([
      { artifactId: "art_1", version: 2, sha256: "hash_brief_2" },
      { artifactId: "art_2", version: 1, sha256: "hash_constraints_1" },
    ]);
    expect(plan.notes).toEqual([]);
  });

  test("stops before an approval naming an artifact the bundle does not carry", () => {
    const plan = legacyAdoptionPlan(bundle(), "proj_new", new Map([["brief", "art_1"]]));
    expect(plan.steps.map((step) => step.stage)).toEqual([1]);
    expect(plan.notes).toEqual(["Stage 2's approval names an artifact the bundle does not carry; replay stops before it."]);
  });
});

describe("importLegacyProject", () => {
  test("creates the project, writes the versions in order with sources translated, then the transcripts", async () => {
    const { deps, artifacts } = store();
    const progress: [number, number][] = [];
    const result = await importLegacyProject(bundle(), { ...deps, onProgress: (done, total) => progress.push([done, total]) });
    expect(result).toMatchObject({ projectId: "new:Snooker Match (imported)", artifacts: 2, versions: 3, conversations: 1 });
    expect(progress).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);

    const brief = artifacts.get("art_1")!;
    expect(brief.versions.map((write) => write.content)).toEqual(["the brief, first draft", "the brief, approved"]);
    expect(brief.versions[1]!.sb).toMatchObject({ projectId: "new:Snooker Match (imported)", kind: "problem_brief", sourceVersionIds: [] });
    const constraints = artifacts.get("art_2")!;
    expect(constraints.versions[0]!.sb).toMatchObject({ kind: "solution_constraints", stage: 2, sourceVersionIds: ["art_1@2"] });
    expect(artifacts.get("art_3")!.title).toBe("Stage 1 conversation (imported)");

    expect(result.plan.steps.map((step) => step.ref)).toEqual([
      { artifactId: "art_1", version: 2, sha256: "hash_brief_2" },
      { artifactId: "art_2", version: 1, sha256: "hash_constraints_1" },
    ]);
  });

  test("refuses to go on when the store numbers a version differently", async () => {
    const { deps } = store();
    await expect(importLegacyProject(bundle(), { ...deps, reviseArtifact: async () => ({ version: 7 }) })).rejects.toThrow('numbered "Brainstormer — stage 1" version 2 as 7');
  });
});
