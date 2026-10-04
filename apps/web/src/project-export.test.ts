import { describe, expect, test } from "bun:test";
import { archiveBundle, assembleBundle, bundleFileName, isArchiveBundle, parseBundle, type ArchiveBundle, type BundleDeps } from "./project-export.ts";
import type { ArtifactNode } from "./client.ts";

function node(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "node_1",
    kind: "problem_brief",
    variant: null,
    stage: 1,
    title: "Stage 1 draft",
    version: 1,
    position: 1,
    artifactId: "art_1",
    contentHash: "node_1@1",
    sizeBytes: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
    ...overrides,
  };
}

function deps(overrides: Partial<BundleDeps> = {}): BundleDeps {
  return {
    projectView: async () => ({
      project: { id: "proj_1", title: "Renew the lease", policy: { audiences: [], audienceQuorum: 0 } },
      tenantId: "tenant_1",
      nodes: [node()],
    }),
    artifactContent: async () => ({ content: "the brief" }),
    stageAgentAddresses: async (_projectId, stage) => (stage === 1 ? ["dep_1@example"] : []),
    readStageThread: async () => [{ id: "INBOX:1", author: "agent", body: "hello", at: "2026-01-01T00:00:01.000Z" }],
    projectWorkflowView: async () => null,
    ...overrides,
  };
}

describe("assembleBundle", () => {
  test("assembles artifacts, conversations, and project fields as a v4 archive", async () => {
    const bundle = await assembleBundle("proj_1", deps());
    expect(bundle.format).toBe("solutions-builder.project");
    expect(bundle.version).toBe(4);
    expect(isArchiveBundle(bundle)).toBe(true);
    expect(bundle.project).toEqual({ id: "proj_1", title: "Renew the lease", policy: { audiences: [], audienceQuorum: 0 } });
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.versions).toEqual([{ version: 1, content: "the brief" }]);
    expect(bundle.artifacts[0]?.node.id).toBe("node_1");
    expect(bundle.conversations).toEqual([
      { stage: 1, messages: [{ id: "INBOX:1", author: "agent", body: "hello", at: "2026-01-01T00:00:01.000Z" }] },
    ]);
    expect(bundle.workflow).toBeNull();
  });

  test("loads every version of an artifact by its pinned version id", async () => {
    const asked: string[] = [];
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        projectView: async () => ({
          project: { id: "proj_1", title: "Renew the lease", policy: {} },
          tenantId: "tenant_1",
          nodes: [node({ version: 2 })],
        }),
        artifactContent: async (_tenantId, nodeId) => {
          asked.push(nodeId);
          return { content: `body of ${nodeId}` };
        },
      }),
    );
    expect(asked).toEqual(["node_1@1", "node_1@2"]);
    expect(bundle.artifacts[0]?.versions).toEqual([
      { version: 1, content: "body of node_1@1" },
      { version: 2, content: "body of node_1@2" },
    ]);
  });

  test("omits an unreadable older blob version without substituting current bytes or aborting the zip", async () => {
    const asked: string[] = [];
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        projectView: async () => ({
          project: { id: "proj_1", title: "Renew the lease", policy: {} },
          tenantId: "tenant_1",
          nodes: [node({ version: 2 })],
        }),
        artifactContent: async (_tenantId, nodeId) => {
          asked.push(nodeId);
          if (nodeId.endsWith("@1")) throw new Error("Uploaded file content is not versioned");
          return { content: "current blob" };
        },
      }),
    );
    expect(asked).toEqual(["node_1@1", "node_1@2"]);
    expect(bundle.artifacts[0]?.versions).toEqual([{ version: 2, content: "current blob" }]);
    expect(bundle.artifacts[0]?.versions.some((entry) => entry.version === 1)).toBe(false);
  });

  test("omits an artifact whose every pin failed so the zip still parses", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        projectView: async () => ({
          project: { id: "proj_1", title: "Renew the lease", policy: {} },
          tenantId: "tenant_1",
          nodes: [node({ id: "node_good", artifactId: "art_good" }), node({ id: "node_bad", artifactId: "art_bad", title: "Unreadable blob", version: 2 })],
        }),
        artifactContent: async (_tenantId, nodeId) => {
          if (nodeId.startsWith("node_bad")) throw new Error("Uploaded file content is not versioned");
          return { content: "the brief" };
        },
      }),
    );
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.node.id).toBe("node_good");
    expect(bundle.artifacts[0]?.versions).toEqual([{ version: 1, content: "the brief" }]);
    expect(() => parseBundle(bundle)).not.toThrow();
  });

  test("skips stages with no deployed specialist and stages with an empty thread", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        stageAgentAddresses: async (_projectId, stage) => (stage === 1 || stage === 2 ? [`dep_${stage}@example`] : []),
        readStageThread: async (_tenantId, addresses) => (addresses[0] === "dep_1@example" ? [{ id: "1", author: "me", body: "hi", at: "2026-01-01T00:00:00.000Z" }] : []),
      }),
    );
    expect(bundle.conversations.map((c) => c.stage)).toEqual([1]);
  });

  test("never carries a secret-looking field through into the bundle", async () => {
    const secretNode = node({ ...({ providerCredential: { apiKey: "sk-super-secret-token" } } as Partial<ArtifactNode>) });
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        projectView: async () => ({
          project: { id: "proj_1", title: "Renew the lease", policy: { audiences: [] } },
          tenantId: "tenant_1",
          nodes: [secretNode],
        }),
        projectWorkflowView: async () => ({
          stage: 2,
          done: false,
          reviews: { 1: { artifactId: "art_1", version: 1, sha256: "aaa", status: "approved" } },
          decisions: [{ kind: "approve", stage: 1, accepted: true, artifactId: "art_1", version: 1, sha256: "aaa", principalId: "prn_secret" } as never],
          audienceDecisions: { You: { decision: "proceed", note: "", principalId: "prn_secret", apiKey: "sk-workflow-secret" } as never },
          freeze: { target: "macos", decisionId: "dec_secret" } as never,
          audiencePackages: {},
          requirements: [],
        }),
      }),
    );
    const dumped = JSON.stringify(bundle);
    expect(dumped).not.toContain("sk-super-secret-token");
    expect(dumped).not.toContain("providerCredential");
    expect(dumped).not.toContain("prn_secret");
    expect(dumped).not.toContain("sk-workflow-secret");
    expect(dumped).not.toContain("dec_secret");
    expect(dumped).not.toContain("apiKey");
  });
});

describe("parseBundle", () => {
  function validJson(): unknown {
    return {
      format: "solutions-builder.project",
      version: 2,
      exportedAt: "2026-01-01T00:00:00.000Z",
      project: { id: "proj_1", title: "Renew the lease", policy: {} },
      artifacts: [],
      conversations: [],
      notes: "workflow events are not included yet",
    };
  }

  test("accepts a well-formed v2 JSON bundle", () => {
    const parsed = parseBundle(validJson());
    expect(isArchiveBundle(parsed)).toBe(false);
    expect(parsed.version).toBe(2);
  });

  test("rejects the wrong format", () => {
    expect(() => parseBundle({ ...(validJson() as object), format: "something.else" })).toThrow(/format/);
  });

  test("rejects the wrong version", () => {
    expect(() => parseBundle({ ...(validJson() as object), version: 1 })).toThrow(/version/);
  });

  test("rejects a bundle missing a required key", () => {
    const { artifacts: _artifacts, ...rest } = validJson() as Record<string, unknown>;
    expect(() => parseBundle(rest)).toThrow(/artifacts/);
  });

  test("rejects a non-object value", () => {
    expect(() => parseBundle(null)).toThrow();
    expect(() => parseBundle("not a bundle")).toThrow();
  });

  test("a main v3 JSON bundle still reads as one-content JSON, not a zip archive", () => {
    const v3 = {
      format: "solutions-builder.project",
      version: 3,
      exportedAt: "2026-01-02T00:00:00.000Z",
      project: { id: "p", title: "T", policy: {} },
      artifacts: [{ node: node(), content: "the brief" }],
      conversations: [],
      notes: "the workflow's position is carried; the import replays it",
      workflow: {
        stage: 2,
        done: false,
        decisions: [{ kind: "approve", stage: 1, artifactId: "art_1", version: 1, sha256: "aaa" }],
        audienceDecisions: {},
        freeze: null,
      },
    };
    const parsed = parseBundle(v3);
    expect(isArchiveBundle(parsed)).toBe(false);
    expect(parsed.version).toBe(3);
    if (isArchiveBundle(parsed)) throw new Error("expected JSON");
    expect(parsed.artifacts[0]?.content).toBe("the brief");
    expect(parsed.workflow?.stage).toBe(2);
  });

  test("drops an artifact with empty versions so the zip still parses", () => {
    const parsed = parseBundle({
      format: "solutions-builder.project",
      version: 4,
      exportedAt: "2026-01-02T00:00:00.000Z",
      project: { id: "proj_1", title: "Renew the lease", policy: {} },
      artifacts: [
        { node: node(), versions: [{ version: 1, content: "the brief" }] },
        { node: node({ id: "node_bad", artifactId: "art_bad" }), versions: [] },
      ],
      conversations: [],
      workflow: null,
    });
    expect(isArchiveBundle(parsed)).toBe(true);
    if (!isArchiveBundle(parsed)) throw new Error("expected archive");
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0]?.node.id).toBe("node_1");
  });
});

describe("bundleFileName", () => {
  test("slugs the title and appends the export suffix", () => {
    expect(bundleFileName("Renew the Lease!")).toBe("renew-the-lease.solutions-builder.zip");
  });
});

describe("the v4 zip", () => {
  test("carries the stage, reviews, votes and freeze, not the rest of the view", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        projectWorkflowView: async () => ({
          stage: 8,
          done: false,
          reviews: { 1: { artifactId: "art_1", version: 1, sha256: "aaa", status: "approved" } },
          decisions: [
            { kind: "open_review", stage: 1, accepted: true, artifactId: "art_1", version: 1, sha256: "aaa" },
            { kind: "approve", stage: 1, accepted: true, artifactId: "art_1", version: 1, sha256: "aaa" },
            { kind: "approve", stage: 2, accepted: false, artifactId: "art_2", version: 1, sha256: "bbb" },
            { kind: "approve", stage: 7, accepted: true, artifactId: "art_7", version: 1, sha256: "ccc", target: "macos" },
          ],
          audienceDecisions: { You: { decision: "proceed", note: "" }, "Tim Burke": { decision: "proceed", note: "Looks right" } },
          freeze: { target: "macos" },
          audiencePackages: {},
          requirements: [],
        }),
      }),
    );
    expect(bundle.version).toBe(4);
    expect(bundle.workflow).toEqual({
      stage: 8,
      done: false,
      reviews: { 1: { artifactId: "art_1", version: 1, sha256: "aaa", status: "approved" } },
      decisions: [
        { kind: "open_review", stage: 1, accepted: true, artifactId: "art_1", version: 1, sha256: "aaa" },
        { kind: "approve", stage: 1, accepted: true, artifactId: "art_1", version: 1, sha256: "aaa" },
        { kind: "approve", stage: 2, accepted: false, artifactId: "art_2", version: 1, sha256: "bbb" },
        { kind: "approve", stage: 7, accepted: true, artifactId: "art_7", version: 1, sha256: "ccc", target: "macos" },
      ],
      votes: { You: { decision: "proceed" }, "Tim Burke": { decision: "proceed", note: "Looks right" } },
      freeze: { target: "macos" },
      audiencePackages: {},
      requirements: [],
    });
    expect(() => parseBundle(bundle)).not.toThrow();
  });

  test("packs every version as its own file under artifacts/", async () => {
    const bundle: ArchiveBundle = {
      format: "solutions-builder.project",
      version: 4,
      exportedAt: "2026-01-02T00:00:00.000Z",
      project: { id: "proj_1", title: "Renew the lease", policy: {} },
      artifacts: [
        {
          node: node({ version: 2 }),
          versions: [
            { version: 1, content: "first draft" },
            { version: 2, content: "second draft" },
          ],
        },
      ],
      conversations: [],
      workflow: null,
    };
    const zip = archiveBundle(bundle);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
    expect(names).toContain("project.json");
    expect(names.some((name) => name.startsWith("artifacts/") && /v1-r1\.md$/.test(name))).toBe(true);
    expect(names.some((name) => name.startsWith("artifacts/") && /v1\.md$/.test(name) && !name.includes("-r"))).toBe(true);
    expect(await zip.file(names.find((name) => /v1-r1\.md$/.test(name))!)!.async("string")).toBe("first draft");
    expect(await zip.file(names.find((name) => /v1\.md$/.test(name) && !name.includes("-r"))!)!.async("string")).toBe("second draft");
  });

  test("gzip round-trips as real gzip bytes, not a data URI", async () => {
    const gzipBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
    const binary = String.fromCharCode(...gzipBytes);
    const content = `data:application/gzip;base64,${btoa(binary)}`;
    const bundle: ArchiveBundle = {
      format: "solutions-builder.project",
      version: 4,
      exportedAt: "2026-01-02T00:00:00.000Z",
      project: { id: "proj_1", title: "Renew the lease", policy: {} },
      artifacts: [
        {
          node: node({
            id: "build_1",
            kind: "build_evidence",
            variant: "1",
            stage: 8,
            title: "Build archive",
            mediaType: "application/gzip",
            artifactId: "build_1",
          }),
          versions: [{ version: 1, content }],
        },
      ],
      conversations: [],
      workflow: null,
    };
    const zip = archiveBundle(bundle);
    const packed = zip.file("builds/1/build.tar.gz");
    expect(packed).toBeTruthy();
    const bytes = await packed!.async("uint8array");
    expect([...bytes]).toEqual([...gzipBytes]);
    const asText = await packed!.async("string");
    expect(asText.startsWith("data:")).toBe(false);
  });
});
