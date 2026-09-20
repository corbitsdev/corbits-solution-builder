import { describe, expect, test } from "bun:test";
import { buildEvidenceState } from "./build.tsx";
import type { ChatMessage } from "../../stage-mail.ts";
import type { ArtifactNode } from "../../client.ts";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg_1",
    author: "me",
    body: "Start the build attempt.",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ChatMessage;
}

function archiveNode(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "node_1",
    kind: "build_evidence",
    variant: null,
    stage: 8,
    title: "build.tar.gz",
    version: 1,
    artifactId: "art_1",
    contentHash: "sha256:abc",
    mediaType: "application/gzip",
    createdAt: "2026-01-01T00:05:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "agent" },
    approvedAt: null,
    ...overrides,
  };
}

describe("buildEvidenceState", () => {
  test("not ready with no archive at all", () => {
    const state = buildEvidenceState([message()], []);
    expect(state.ready).toBe(false);
    expect(state.reason).toContain("No published build archive");
  });

  test("ready once a published archive exists after the attempt started", () => {
    const state = buildEvidenceState([message()], [archiveNode()]);
    expect(state.ready).toBe(true);
    expect(state.reason).toBeNull();
  });

  test("ignores a text/markdown node — that is chat prose, not the archive", () => {
    const state = buildEvidenceState([message()], [archiveNode({ mediaType: "text/markdown" })]);
    expect(state.ready).toBe(false);
  });

  test("not ready when a new attempt started after the last published archive", () => {
    const state = buildEvidenceState(
      [message({ at: "2026-01-01T00:10:00.000Z", body: "Continue the build." })],
      [archiveNode({ createdAt: "2026-01-01T00:05:00.000Z" })],
    );
    expect(state.ready).toBe(false);
    expect(state.reason).toContain("current attempt has not published");
  });

  test("stays ready once the current attempt republishes after that later start", () => {
    const state = buildEvidenceState(
      [message({ at: "2026-01-01T00:10:00.000Z", body: "Continue the build." })],
      [archiveNode({ createdAt: "2026-01-01T00:20:00.000Z" })],
    );
    expect(state.ready).toBe(true);
  });
});
