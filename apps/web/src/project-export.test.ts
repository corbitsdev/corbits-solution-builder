import { describe, expect, test } from "bun:test";
import { assembleBundle, bundleFileName, condensedMessage, parseBundle, type BundleDeps } from "./project-export.ts";
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
    artifactVersions: async () => [{ version: 1, content: "the brief" }],
    stageAgentAddresses: async (_projectId, stage) => (stage === 1 ? ["dep_1@example"] : []),
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
    expect(bundle.version).toBe(4);
    expect(bundle.notes).toBe("workflow events are not included");
    expect(bundle.workflow).toBeUndefined();
    expect(bundle.project).toEqual({ id: "proj_1", title: "Renew the lease", policy: { audiences: [], audienceQuorum: 0 } });
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.content).toBe("the brief");
    expect(bundle.artifacts[0]?.versions).toEqual([{ version: 1, content: "the brief" }]);
    expect(bundle.artifacts[0]?.sources).toEqual([]);
    expect(bundle.artifacts[0]?.node.id).toBe("node_1");
    expect(bundle.conversations).toEqual([
      { stage: 1, messages: [{ id: "INBOX:1", author: "agent", body: "hello", at: "2026-01-01T00:00:01.000Z" }] },
    ]);
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

  // #632: every version rides along, oldest first; `content` stays the current one.
  test("carries each artifact's version chain, the current content last", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        projectView: async () => ({ project: { id: "proj_1", title: "Renew the lease", policy: {} }, tenantId: "tenant_1", nodes: [node({ version: 3 })] }),
        artifactVersions: async (_tenantId, nodeId) => [
          { version: 1, content: `${nodeId} first` },
          { version: 2, content: `${nodeId} second` },
          { version: 3, content: `${nodeId} third` },
        ],
      }),
    );
    expect(bundle.artifacts[0]?.versions).toEqual([
      { version: 1, content: "node_1 first" },
      { version: 2, content: "node_1 second" },
      { version: 3, content: "node_1 third" },
    ]);
    expect(bundle.artifacts[0]?.content).toBe("node_1 third");
    expect(() => parseBundle(JSON.parse(JSON.stringify(bundle)))).not.toThrow();
  });

  // #632: what each node was generated from rides along, so the import can link it again.
  test("carries each node's bundled sources from the graph's edges, never one outside the bundle", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        projectView: async () => ({
          project: { id: "proj_1", title: "Renew the lease", policy: {} },
          tenantId: "tenant_1",
          nodes: [node({ id: "brief" }), node({ id: "shape", stage: 2, kind: "solution_constraints" })],
        }),
        artifactEdges: async () => [
          { childNodeId: "shape", sourceNodeId: "brief" },
          { childNodeId: "shape", sourceNodeId: "pruned" },
          { childNodeId: "elsewhere", sourceNodeId: "brief" },
        ],
      }),
    );
    expect(bundle.artifacts.map((artifact) => [artifact.node.id, artifact.sources])).toEqual([
      ["brief", []],
      ["shape", ["brief"]],
    ]);
    expect(() => parseBundle(JSON.parse(JSON.stringify(bundle)))).not.toThrow();
  });

  test("an artifact the store cannot read exports with no versions and empty content", async () => {
    const bundle = await assembleBundle("proj_1", deps({ artifactVersions: async () => [] }));
    expect(bundle.artifacts[0]?.versions).toEqual([]);
    expect(bundle.artifacts[0]?.content).toBe("");
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

  test("rejects a malformed versions array, and accepts an artifact without one", () => {
    const base = validBundle() as Record<string, unknown>;
    const node = { id: "n", kind: "problem_brief", stage: 1, title: "t", version: 1, artifactId: "n", contentHash: "n@1", createdAt: "2026-01-01T00:00:00.000Z", supersededByNodeId: null, provenance: { producer: "agent" } };
    expect(() => parseBundle({ ...base, version: 4, artifacts: [{ node, content: "x", versions: [{ version: "1", content: "x" }] }] })).toThrow(/versions/);
    expect(() => parseBundle({ ...base, version: 4, artifacts: [{ node, content: "x", versions: "x" }] })).toThrow(/versions/);
    expect(() => parseBundle({ ...base, version: 4, artifacts: [{ node, content: "x", sources: [1] }] })).toThrow(/sources/);
    expect(() => parseBundle({ ...base, version: 3, artifacts: [{ node, content: "x" }] })).not.toThrow();
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

// #652: a v3 bundle carries the workflow's position; a v2 bundle still reads.
describe("the bundle's workflow", () => {
  test("carries the stage, the accepted decisions, the votes and the freeze", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        workflowView: async () => ({
          stage: 8,
          done: false,
          decisions: [
            { kind: "open_review", stage: 1, accepted: true, artifactId: "art_1", version: 1, sha256: "aaa" },
            { kind: "approve", stage: 1, accepted: true, artifactId: "art_1", version: 1, sha256: "aaa" },
            { kind: "approve", stage: 2, accepted: false, artifactId: "art_2", version: 1, sha256: "bbb" },
            { kind: "approve", stage: 7, accepted: true, artifactId: "art_7", version: 1, sha256: "ccc", target: "macos" },
          ],
          audienceDecisions: { You: { decision: "proceed", note: "" }, "Tim Burke": { decision: "proceed", note: "Looks right" } },
          freeze: { target: "macos" },
        }),
      }),
    );
    expect(bundle.version).toBe(4);
    expect(bundle.workflow).toEqual({
      stage: 8,
      done: false,
      decisions: [
        { kind: "open_review", stage: 1, artifactId: "art_1", version: 1, sha256: "aaa" },
        { kind: "approve", stage: 1, artifactId: "art_1", version: 1, sha256: "aaa" },
        { kind: "approve", stage: 7, artifactId: "art_7", version: 1, sha256: "ccc", target: "macos" },
      ],
      audienceDecisions: { You: { decision: "proceed" }, "Tim Burke": { decision: "proceed", note: "Looks right" } },
      freeze: { target: "macos" },
    });
    expect(() => parseBundle(bundle)).not.toThrow();
  });

  test("a v2 bundle is still accepted", () => {
    const v2 = { format: "solutions-builder.project", version: 2, exportedAt: "2026-01-02T00:00:00.000Z", project: { id: "p", title: "T", policy: {} }, artifacts: [], conversations: [], notes: "workflow events are not included yet" };
    expect(() => parseBundle(v2)).not.toThrow();
  });
});

// #879: a hand-off's recap is for the specialist it went to; one from before
// #305 quoted every earlier recap too, and the thread outgrew any import.
describe("condensedMessage", () => {
  const handoff = [
    "[[sb-switch:c92f1ce8]]",
    "This stage continues on Anthropic · claude-fable-5-1.",
    "---",
    "Here is the conversation so far, so you can pick it up without restarting it:",
    "",
    "Person: a question",
    "",
    "Specialist: an answer",
    "---",
    "The current draft:",
    "",
    "<html>a whole mockup</html>",
    "---",
    "If the person's last message above has not been answered, answer it now.",
  ].join("\n\n");

  test("keeps a hand-off's marker and announcement, with the line the window shows, and nothing it carried", () => {
    const condensed = condensedMessage({ id: "1", author: "me", body: handoff, at: "2026-01-01T00:00:00.000Z" });
    expect(condensed.body).toBe("[[sb-switch:c92f1ce8]]\nThis stage continues on Anthropic · claude-fable-5-1.\nHanded the conversation so far, and the current draft, to the new specialist.");
    expect(condensed.body).not.toContain("a whole mockup");
  });

  test("a hand-off without a marker keeps only the line the window shows", () => {
    const body = `Here is the conversation so far, so you can pick it up without restarting it:\n\nPerson: a question`;
    expect(condensedMessage({ id: "1", author: "me", body, at: "2026-01-01T00:00:00.000Z" }).body).toBe("Handed the conversation so far, and the current draft, to the new specialist.");
  });

  test("a specialist's message is never condensed, whatever it says", () => {
    const message = { id: "2", author: "agent" as const, body: handoff, at: "2026-01-01T00:00:01.000Z" };
    expect(condensedMessage(message)).toBe(message);
  });

  test("the bundle carries the condensed hand-off, the other turns whole", async () => {
    const bundle = await assembleBundle(
      "proj_1",
      deps({
        readStageThread: async () => [
          { id: "1", author: "me", body: "a question", at: "2026-01-01T00:00:00.000Z" },
          { id: "2", author: "me", body: handoff, at: "2026-01-01T00:00:01.000Z" },
          { id: "3", author: "agent", body: "picked up", at: "2026-01-01T00:00:02.000Z" },
        ],
      }),
    );
    expect(bundle.conversations[0]?.messages.map((message) => message.body)).toEqual([
      "a question",
      "[[sb-switch:c92f1ce8]]\nThis stage continues on Anthropic · claude-fable-5-1.\nHanded the conversation so far, and the current draft, to the new specialist.",
      "picked up",
    ]);
  });
});
