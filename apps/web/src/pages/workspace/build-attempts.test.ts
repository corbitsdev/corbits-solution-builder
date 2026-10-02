import { describe, expect, test } from "bun:test";
import { attemptOfNode, attemptRecorded, buildEvidenceState, composeSupervisorBrief } from "./build-attempts.ts";
import type { ArtifactNode, BridgeOutcome } from "../../client.ts";

function archiveNode(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "node_1",
    kind: "build_evidence",
    variant: "attempt-2",
    stage: 8,
    title: "build.tar.gz",
    version: 1,
    artifactId: "art_1",
    contentHash: "art_1@1",
    mediaType: "application/gzip",
    createdAt: "2026-01-01T00:05:00.000Z",
    supersededByNodeId: null,
    provenance: { producer: "host", attempt: 2 },
    ...overrides,
  };
}

describe("attemptOfNode", () => {
  test("reads the attempt number off the variant the host and publish_workspace share", () => {
    expect(attemptOfNode({ variant: "attempt-3" })).toBe(3);
    expect(attemptOfNode({ variant: null })).toBeNull();
    expect(attemptOfNode({ variant: "finance" })).toBeNull();
  });
});

describe("buildEvidenceState", () => {
  test("not ready with no archive at all", () => {
    const state = buildEvidenceState([], [{ attempt: 1, state: "ended" }]);
    expect(state.ready).toBe(false);
    expect(state.reason).toContain("No build archive");
  });

  test("ready once the ended attempt's archive is recorded", () => {
    expect(buildEvidenceState([archiveNode()], [{ attempt: 2, state: "ended" }])).toEqual({ ready: true, reason: null });
  });

  test("a text/markdown node is chat prose, not the archive", () => {
    expect(buildEvidenceState([archiveNode({ mediaType: "text/markdown" })], [{ attempt: 2, state: "ended" }]).ready).toBe(false);
  });

  test("not ready while a worker is running", () => {
    const state = buildEvidenceState([archiveNode()], [{ attempt: 2, state: "ended" }, { attempt: 3, state: "running" }]);
    expect(state.ready).toBe(false);
    expect(state.reason).toContain("still running");
  });

  test("not ready when a later attempt ended and was not packaged", () => {
    const state = buildEvidenceState([archiveNode()], [{ attempt: 2, state: "ended" }, { attempt: 3, state: "ended" }]);
    expect(state.ready).toBe(false);
    expect(state.reason).toContain("Attempt 3 has not been packaged");
  });

  test("an archive that names no attempt is taken as the current one", () => {
    expect(buildEvidenceState([archiveNode({ variant: null })], [{ attempt: 5, state: "ended" }]).ready).toBe(true);
  });

  test("attemptRecorded answers for one attempt", () => {
    expect(attemptRecorded([archiveNode()], 2)).toBe(true);
    expect(attemptRecorded([archiveNode()], 3)).toBe(false);
  });
});

describe("composeSupervisorBrief", () => {
  const outcome: BridgeOutcome = {
    bridgeId: "bounded-local-corbits-exec",
    worker: "corbits-code",
    command: "corbits",
    available: true,
    exitStatus: 0,
    signal: null,
    finalText: "Built the API and the web app. Tests pass.",
    stderrTail: "",
    workspace: "/data/builds/p/attempts/2",
    turnLog: "/data/builds/p/attempts/2.turns.jsonl",
    turns: 14,
    toolCalls: 31,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T01:00:00.000Z",
    checkpointRef: null,
  };
  const archive = { fileName: "build.tar.gz", sha256: "abc", sizeBytes: 1234 };

  test("says the worker, how it ended, its final text, the archive and the checks, and claims no control it lacks", () => {
    const brief = composeSupervisorBrief({
      attempt: 2,
      outcome,
      archive,
      verification: { complete: true, failed: [], targets: [{ target: "web", ranSuccessfully: true, transcript: "" }] },
    });
    expect(brief).toContain("Build attempt 2 has ended");
    expect(brief).toContain("corbits-code (`corbits`), exited 0; 14 turns, 31 tool calls");
    expect(brief).toContain("Built the API and the web app.");
    expect(brief).toContain("sha256 abc, recorded as attempt-2");
    expect(brief).toContain("Deterministic checks: complete.");
    expect(brief).toContain("- web: responded");
    expect(brief).toContain("no session, steering or checkpoint exists");
  });

  test("a cancelled worker is said by its signal, a failed check by name, and silence as silence", () => {
    const brief = composeSupervisorBrief({
      attempt: 3,
      outcome: { ...outcome, exitStatus: null, signal: "SIGTERM", finalText: "", stderrTail: "killed", turns: null, toolCalls: null },
      archive,
      verification: { complete: false, failed: ["src/index.ts"], targets: [] },
    });
    expect(brief).toContain("ended by SIGTERM");
    expect(brief).toContain("no turn reports");
    expect(brief).toContain("(the worker wrote nothing to stdout)");
    expect(brief).toContain("Last lines of stderr\nkilled");
    expect(brief).toContain("incomplete — not verified: src/index.ts");
    expect(brief).toContain("No target was started or probed");
  });

  test("a long final text keeps its tail, which is where a worker sums up", () => {
    const brief = composeSupervisorBrief({ attempt: 1, outcome: { ...outcome, finalText: `${"x".repeat(30_000)}END` }, archive, verification: { complete: true, failed: [], targets: [] } });
    expect(brief).toContain("…");
    expect(brief).toContain("END");
    expect(brief.length).toBeLessThan(22_000);
  });
});
