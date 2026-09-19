import { describe, expect, test } from "bun:test";
import { assembleBundle, bundleFileName, parseBundle, type BundleDeps } from "./project-export.ts";
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
    sizeBytes: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
    approvedAt: "2026-01-01T00:00:00.000Z",
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
    stageAgentStatus: async (_projectId, stage) => (stage === 1 ? { address: "dep_1@example" } : null),
    readStageThread: async () => [
      { id: "INBOX:1", author: "agent", body: "hello", at: "2026-01-01T00:00:01.000Z" },
    ],
    ...overrides,
  };
}

describe("assembleBundle", () => {
  test("assembles artifacts, conversations, and project fields", async () => {
    const bundle = await assembleBundle("proj_1", deps());
    expect(bundle.format).toBe("solutions-builder.project");
    expect(bundle.version).toBe(2);
    expect(bundle.notes).toBe("workflow events are not included yet");
    expect(bundle.project).toEqual({ id: "proj_1", title: "Renew the lease", policy: { audiences: [], audienceQuorum: 0 } });
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.content).toBe("the brief");
    expect(bundle.artifacts[0]?.node.id).toBe("node_1");
    expect(bundle.conversations).toEqual([
      { stage: 1, messages: [{ id: "INBOX:1", author: "agent", body: "hello", at: "2026-01-01T00:00:01.000Z" }] },
    ]);
  });

  test("skips stages with no deployed specialist and stages with an empty thread", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        stageAgentStatus: async (_projectId, stage) => (stage === 1 || stage === 2 ? { address: `dep_${stage}@example` } : null),
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
      }),
    );
    expect(JSON.stringify(bundle)).not.toContain("sk-super-secret-token");
    expect(JSON.stringify(bundle)).not.toContain("providerCredential");
  });
});

describe("parseBundle", () => {
  function validBundle(): unknown {
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

  test("accepts a well-formed bundle", () => {
    expect(() => parseBundle(validBundle())).not.toThrow();
  });

  test("rejects the wrong format", () => {
    expect(() => parseBundle({ ...(validBundle() as object), format: "something.else" })).toThrow(/format/);
  });

  test("rejects the wrong version", () => {
    expect(() => parseBundle({ ...(validBundle() as object), version: 1 })).toThrow(/version/);
  });

  test("rejects a bundle missing a required key", () => {
    const { artifacts: _artifacts, ...rest } = validBundle() as Record<string, unknown>;
    expect(() => parseBundle(rest)).toThrow(/artifacts/);
  });

  test("rejects a non-object value", () => {
    expect(() => parseBundle(null)).toThrow();
    expect(() => parseBundle("not a bundle")).toThrow();
  });
});

describe("bundleFileName", () => {
  test("slugs the title and appends the export suffix", () => {
    expect(bundleFileName("Renew the Lease!")).toBe("renew-the-lease.solutions-builder.json");
  });
});
