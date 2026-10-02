/**
 * Stage 8's build attempts, as the host records them.
 *
 * The host's bounded bridge (`apps/hub/src/build-attempts.ts`) runs the
 * coding agent and keeps one directory per attempt; this client starts,
 * continues, cancels and watches those attempts, and when one has ended,
 * has the host package it (`/package`: the same archive, hashes and target
 * probes `publish_workspace` ran) and records the archive as the stage's
 * `build_evidence`, with the host as its producer and the attempt it came
 * from. The stage's specialist, the Build supervisor, is then briefed with
 * what the worker reported and writes the build status.
 *
 * Everything here is pure or a thin poll; nothing infers progress from the
 * worker's output. The verdict on a build stays a person's.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type ArtifactNode, type BridgeOutcome, type BuildAttempt } from "../../client.js";

/** The attempt an archive node was recorded for, from its `attempt-<n>` variant; null when it names none. */
export function attemptOfNode(node: Pick<ArtifactNode, "variant">): number | null {
  const match = /^attempt-(\d+)$/.exec(node.variant ?? "");
  return match ? Number(match[1]) : null;
}

/** The live build archives, newest first. */
export function buildArchives(nodes: readonly ArtifactNode[]): ArtifactNode[] {
  return nodes
    .filter((node) => node.kind === "build_evidence" && node.mediaType === "application/gzip" && node.supersededByNodeId === null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Whether an attempt's archive is already recorded. */
export function attemptRecorded(nodes: readonly ArtifactNode[], attempt: number): boolean {
  return buildArchives(nodes).some((node) => attemptOfNode(node) === attempt);
}

/**
 * Whether stage 8 has evidence to review: an archive the host packaged and
 * this client recorded, for an attempt that has ended, and no later attempt
 * since. A worker still running, or a newer attempt than the one recorded,
 * means the archive is not what is being built now.
 */
export function buildEvidenceState(
  nodes: readonly ArtifactNode[],
  attempts: readonly Pick<BuildAttempt, "attempt" | "state">[],
): { ready: boolean; reason: string | null } {
  const archive = buildArchives(nodes)[0];
  if (!archive) return { ready: false, reason: "No build archive has been recorded yet — package an ended attempt first." };
  if (attempts.some((entry) => entry.state === "running" || entry.state === "detached")) {
    return { ready: false, reason: "A build attempt is still running. Its work can be packaged once the worker has ended." };
  }
  const recordedFor = attemptOfNode(archive);
  const newest = attempts.reduce((max, entry) => Math.max(max, entry.attempt), 0);
  if (recordedFor !== null && newest > recordedFor) {
    return { ready: false, reason: `Attempt ${String(newest)} has not been packaged yet; the recorded archive is attempt ${String(recordedFor)}'s.` };
  }
  return { ready: true, reason: null };
}

/** What the record step tells the supervisor, in the worker's own terms. */
export type SupervisorBriefInput = {
  readonly attempt: number;
  readonly outcome: BridgeOutcome;
  readonly archive: { readonly fileName: string; readonly sha256: string; readonly sizeBytes: number };
  readonly verification: {
    readonly complete: boolean;
    readonly failed: readonly string[];
    readonly targets: readonly { target: string; ranSuccessfully: boolean; transcript: string }[];
  };
};

/** Where the package step's target probes ran: on the host, with the start command the person typed. */
const PROBE_RAN_ON = "started on this computer by the host, with the start command the person gave";

const FINAL_TEXT_KEEP = 20_000;

/**
 * The brief the supervisor is mailed when an attempt is recorded: what the
 * worker was, how it ended, what it said, and what the deterministic checks
 * found. Said as it was — no verdict, no inferred progress — so the status
 * the supervisor writes rests on the record and nothing else.
 */
export function composeSupervisorBrief(input: SupervisorBriefInput): string {
  const { outcome } = input;
  const ended =
    outcome.signal !== null
      ? `ended by ${outcome.signal}${outcome.exitStatus !== null ? ` (exit status ${String(outcome.exitStatus)})` : ""}`
      : outcome.exitStatus !== null
        ? `exited ${String(outcome.exitStatus)}`
        : "did not report an exit status";
  const reported = outcome.turns !== null ? `${String(outcome.turns)} turn${outcome.turns === 1 ? "" : "s"}, ${String(outcome.toolCalls ?? 0)} tool call${outcome.toolCalls === 1 ? "" : "s"} reported through its hook` : "no turn reports (the worker has no hook)";
  const finalText = outcome.finalText.length > FINAL_TEXT_KEEP ? `…${outcome.finalText.slice(-FINAL_TEXT_KEEP)}` : outcome.finalText;
  const targets =
    input.verification.targets.length === 0
      ? "- No target was started or probed: the plan declared none the host could run."
      : input.verification.targets.map((target) => `- ${target.target}: ${target.ranSuccessfully ? "responded" : "did not respond"} (${PROBE_RAN_ON}).`).join("\n");
  return [
    `Build attempt ${String(input.attempt)} has ended and its work is recorded. Write the build status from this record.`,
    ``,
    `## What the worker reported`,
    `- Worker: ${outcome.worker} (\`${outcome.command}\`), ${ended}; ${reported}.`,
    `- Ran from ${outcome.startedAt} to ${outcome.endedAt}.`,
    `- The interface gives a final text and an exit status and nothing else: no session, steering or checkpoint exists.`,
    ``,
    `### Final text`,
    finalText.trim().length > 0 ? finalText.trim() : "(the worker wrote nothing to stdout)",
    ...(outcome.stderrTail.trim().length > 0 ? [``, `### Last lines of stderr`, outcome.stderrTail.trim()] : []),
    ``,
    `## Evidence recorded`,
    `- Archive ${input.archive.fileName}, ${String(input.archive.sizeBytes)} bytes, sha256 ${input.archive.sha256}, recorded as attempt-${String(input.attempt)}.`,
    `- Deterministic checks: ${input.verification.complete ? "complete" : `incomplete — not verified: ${input.verification.failed.join(", ") || "(unnamed)"}`}.`,
    targets,
  ].join("\n");
}

/**
 * The host's attempts for a project, polled while one is running and
 * refreshed on demand. Shared by the panel and the stage's decisions so
 * both read the same list.
 */
export function useBuildAttempts(projectId: string, enabled: boolean): {
  attempts: BuildAttempt[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [attempts, setAttempts] = useState<BuildAttempt[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const result = await api.buildAttempts(projectId);
      setAttempts(result.attempts);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, [projectId, enabled]);

  useEffect(() => {
    setAttempts([]);
    setLoaded(false);
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  const running = attempts.some((entry) => entry.state === "running" || entry.state === "detached");
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void refresh(), running ? 2_000 : 10_000);
    return () => clearInterval(timer);
  }, [enabled, running, refresh]);

  return { attempts, loaded, error, refresh };
}
