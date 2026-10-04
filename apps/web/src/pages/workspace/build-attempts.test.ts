import { describe, expect, test } from "bun:test";
import { attemptOfNode, attemptRecorded, buildEvidenceState, composeProgressBrief, composeSupervisorBrief, forecastSection, latestTurn, probeDecision, progressBriefDue, progressBriefOf, statusFreshness, toolCallsSoFar } from "./build-attempts.ts";
import type { ArtifactNode, BridgeOutcome } from "../../client.ts";

function archiveNode(overrides: Partial<ArtifactNode> = {}): ArtifactNode {
  return {
    id: "node_1",
    kind: "build_evidence",
    variant: "attempt-2",
    stage: 8,
    title: "build.tar.gz",
    version: 1,
    position: 1,
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

  test("not ready before the host's attempts have been read: an empty list is not yet an answer", () => {
    const state = buildEvidenceState([archiveNode()], [], false);
    expect(state.ready).toBe(false);
    expect(buildEvidenceState([archiveNode()], [{ attempt: 2, state: "ended" }], true).ready).toBe(true);
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

describe("probeDecision", () => {
  test("blank fields start nothing, and the reason is that they were blank", () => {
    const decision = probeDecision({ startCommand: "", port: "", frozenTarget: "api" });
    expect(decision.targets).toEqual([]);
    expect(decision.skipped).toContain("no start command and port were given");
  });

  test("the target probed is the one stage 7 froze, so an api target is probed as an api", () => {
    const decision = probeDecision({ startCommand: "bun run start", port: "8080", frozenTarget: "api" });
    expect(decision.targets).toEqual([{ target: "api", command: "bun run start", port: 8080 }]);
    expect(decision.skipped).toBeNull();
    expect(probeDecision({ startCommand: "npm start", port: "3000", frozenTarget: null }).targets[0]?.target).toBe("web");
  });

  test("a port that is not one is said, not guessed", () => {
    expect(probeDecision({ startCommand: "npm start", port: "eighty", frozenTarget: "web" }).skipped).toContain("not a port");
    expect(probeDecision({ startCommand: "", port: "3000", frozenTarget: "web" }).skipped).toContain("no start command");
  });
});

describe("forecastSection", () => {
  test("reads the estimate's own Forecast section and nothing past the next heading", () => {
    const estimate = "## In short\n- x\n\n## Forecast\n- **Build:** $1,200\n- **Inference:** $40\n\n## Scope priced\n- a";
    expect(forecastSection(estimate)).toBe("- **Build:** $1,200\n- **Inference:** $40");
    expect(forecastSection("## In short\n- nothing here")).toBeNull();
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
  const archive = { fileName: "build.tar.gz", sha256: "abc", sizeBytes: 1234, fileCount: 1 };

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
    // Without a forecast the brief says there is none, so the heading is answered honestly.
    expect(brief).toContain("No forecast could be read from the Cost approval estimate");
  });

  test("stage 7's forecast is carried for the cost heading when it can be read", () => {
    const brief = composeSupervisorBrief({ attempt: 2, outcome, archive, forecast: "- **Build:** $1,200", verification: { complete: true, failed: [], targets: [] } });
    expect(brief).toContain("## Cost approval forecast\n- **Build:** $1,200");
  });

  test("a cancelled worker is said by its signal, a failed check by name, and silence as silence", () => {
    const brief = composeSupervisorBrief({
      attempt: 3,
      outcome: { ...outcome, exitStatus: null, signal: "SIGTERM", finalText: "", stderrTail: "killed", turns: null, toolCalls: null },
      archive,
      probeSkipped: "No target was started or probed: no start command and port were given when this attempt was recorded.",
      verification: { complete: false, failed: ["src/index.ts"], targets: [] },
    });
    expect(brief).toContain("ended by SIGTERM");
    expect(brief).toContain("no turn reports");
    expect(brief).toContain("(the worker wrote nothing to stdout)");
    expect(brief).toContain("Last lines of stderr\nkilled");
    expect(brief).toContain("incomplete — not verified: src/index.ts");
    expect(brief).toContain("no start command and port were given when this attempt was recorded");
    expect(brief).not.toContain("the plan declared none");
  });

  test("a long final text keeps its tail, which is where a worker sums up", () => {
    const brief = composeSupervisorBrief({ attempt: 1, outcome: { ...outcome, finalText: `${"x".repeat(30_000)}END` }, archive, verification: { complete: true, failed: [], targets: [] } });
    expect(brief).toContain("…");
    expect(brief).toContain("END");
    expect(brief.length).toBeLessThan(22_000);
  });
});

// #695: the supervisor is briefed while the worker runs, and the status says how fresh it is.
const LOG = [
  "── turn 1 · 2 tool calls · 3.0s",
  "   bash {\"command\":\"ls\"}",
  "   read_file {\"path\":\"AGENTS.md\"}",
  "── turn 2 · 1 tool call · 301.1s",
  "   wait_agents {\"targets\":[\"a\"],\"mode\":\"all\"}",
  "",
].join("\n");

describe("latestTurn and toolCallsSoFar", () => {
  test("read the worker's own turn lines, and say null before the first", () => {
    expect(latestTurn(LOG)).toBe(2);
    expect(toolCallsSoFar(LOG)).toBe(3);
    expect(latestTurn("Waiting…")).toBeNull();
    expect(toolCallsSoFar("")).toBe(0);
  });
});

describe("composeProgressBrief", () => {
  test("says the attempt is still running, as of which turn, with the last turn lines and no verdict", () => {
    const brief = composeProgressBrief({ attempt: 1, startedAt: "2026-10-04T19:42:21.000Z", now: "2026-10-04T20:42:21.000Z", log: LOG, worker: "Corbits Code" });
    expect(brief.startsWith("Build attempt 1 is still running; write an interim build status from this record, as of turn 2 at ")).toBe(true);
    expect(brief).toContain("Worker: Corbits Code, running since");
    expect(brief).toContain("(60 minutes)");
    expect(brief).toContain("2 turns and 3 tool calls reported through its hook");
    expect(brief).toContain("The attempt has not ended");
    expect(brief).toContain("wait_agents");
    expect(brief).toContain("a task it is working on, not one that is done");
    expect(progressBriefOf({ author: "me", body: brief }, 1)).toEqual({ turn: 2 });
    expect(progressBriefOf({ author: "me", body: brief }, 2)).toBeNull();
    expect(progressBriefOf({ author: "agent", body: brief }, 1)).toBeNull();
  });

  test("says 'none yet' before the first turn", () => {
    const brief = composeProgressBrief({ attempt: 3, startedAt: "2026-10-04T19:42:21.000Z", now: "2026-10-04T19:43:21.000Z", log: "" });
    expect(brief).toContain("as of turn none yet at");
    expect(brief).toContain("No turn has been reported yet.");
    expect(progressBriefOf({ author: "me", body: brief }, 3)).toEqual({ turn: null });
  });
});

describe("progressBriefDue", () => {
  const startedAt = "2026-10-04T19:00:00.000Z";
  const at = (minutes: number) => new Date(Date.parse(startedAt) + minutes * 60_000).toISOString();
  const brief = (turn: number, minutes: number) => ({ author: "me" as const, body: composeProgressBrief({ attempt: 1, startedAt, now: at(minutes), log: `── turn ${String(turn)} · 1 tool call · 1.0s\n` }), at: at(minutes) });
  const reply = (minutes: number) => ({ author: "agent" as const, body: "## In short\nInterim.", at: at(minutes) });

  test("waits for the worker's first turn and a couple of minutes, then briefs", () => {
    expect(progressBriefDue({ messages: [], attempt: 1, startedAt, turn: null, now: at(30) })).toBe(false);
    expect(progressBriefDue({ messages: [], attempt: 1, startedAt, turn: 1, now: at(1) })).toBe(false);
    expect(progressBriefDue({ messages: [], attempt: 1, startedAt, turn: 1, now: at(2) })).toBe(true);
  });

  test("briefs again only after the interval, a further turn, and the supervisor's answer", () => {
    const answered = [brief(5, 2), reply(3)];
    expect(progressBriefDue({ messages: answered, attempt: 1, startedAt, turn: 9, now: at(11) })).toBe(false);
    expect(progressBriefDue({ messages: answered, attempt: 1, startedAt, turn: 5, now: at(13) })).toBe(false);
    expect(progressBriefDue({ messages: answered, attempt: 1, startedAt, turn: 9, now: at(13) })).toBe(true);
    const unanswered = [brief(5, 2)];
    expect(progressBriefDue({ messages: unanswered, attempt: 1, startedAt, turn: 9, now: at(13) })).toBe(false);
    expect(progressBriefDue({ messages: unanswered, attempt: 1, startedAt, turn: 9, now: at(23) })).toBe(true);
  });

  test("a brief for another attempt does not count", () => {
    const other = { author: "me" as const, body: composeProgressBrief({ attempt: 2, startedAt, now: at(1), log: "── turn 1 · 1 tool call · 1.0s\n" }), at: at(1) };
    expect(progressBriefDue({ messages: [other, reply(2)], attempt: 1, startedAt, turn: 1, now: at(2) })).toBe(true);
  });
});

describe("statusFreshness", () => {
  const startedAt = "2026-10-04T19:42:21.000Z";
  const attempt = { attempt: 1, startedAt, state: "running" as const };
  test("names an interim status by the turn its brief was as of", () => {
    const brief = { id: "b", author: "me" as const, body: composeProgressBrief({ attempt: 1, startedAt, now: "2026-10-04T20:00:00.000Z", log: LOG }), at: "2026-10-04T20:00:00.000Z" };
    const status = { id: "s", author: "agent" as const, body: "## In short", at: "2026-10-04T20:00:30.000Z" };
    expect(statusFreshness([brief, status], status, attempt)).toMatch(/^interim, as of turn 2 · /);
  });
  test("names a status written on a recorded attempt", () => {
    const record = { id: "r", author: "me" as const, body: "Build attempt 1 has ended and its work is recorded. Write the build status from this record.", at: "2026-10-04T23:00:00.000Z" };
    const status = { id: "s", author: "agent" as const, body: "## In short", at: "2026-10-04T23:00:30.000Z" };
    expect(statusFreshness([record, status], status, { ...attempt, state: "ended" })).toMatch(/^on attempt 1's record · /);
  });
  test("says when the status predates the attempt in view", () => {
    const opening = { id: "o", author: "me" as const, body: "Here is the frozen plan.", at: "2026-10-04T19:00:00.000Z" };
    const status = { id: "s", author: "agent" as const, body: "Build not started", at: "2026-10-04T19:01:00.000Z" };
    expect(statusFreshness([opening, status], status, attempt)).toMatch(/^written before attempt 1 started · /);
    expect(statusFreshness([status], status, null)).not.toMatch(/before|interim|record/);
  });
});
