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
import type { ChatMessage } from "../../stage-mail.ts";
import { pairReplies } from "../../withdrawn-turns.ts";
import { appSubject } from "./composed-mail.ts";
import { zonedTime } from "./delivery-opening.ts";

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
  /** Whether `attempts` has been read from the host at all: before that, an empty list says nothing. */
  loaded = true,
): { ready: boolean; reason: string | null } {
  if (!loaded) return { ready: false, reason: "Reading the host's build attempts…" };
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
  readonly archive: { readonly fileName: string; readonly sha256: string; readonly sizeBytes: number; readonly fileCount: number };
  /** Why no target was probed, when none was: the actual reason, from `probeDecision`. */
  readonly probeSkipped?: string | null;
  /** Stage 7's forecast, as the estimator wrote it (`forecastSection`); null when none could be read. */
  readonly forecast?: string | null;
  readonly verification: {
    readonly complete: boolean;
    readonly failed: readonly string[];
    readonly targets: readonly { target: string; ranSuccessfully: boolean; transcript: string }[];
  };
};

/** Where the package step's target probes ran: on the host, with the start command the person typed. */
const PROBE_RAN_ON = "started on this computer by the host, with the start command the person gave";

/**
 * The `## Forecast` section of stage 7's estimate, the figure the
 * supervisor's "Cost against forecast" heading is measured against; null
 * when the estimate has no such section. Read, never computed: the
 * estimator's own words are what the person approved.
 */
export function forecastSection(estimate: string): string | null {
  const lines = estimate.split("\n");
  const start = lines.findIndex((line) => /^##\s+forecast\s*$/i.test(line.trim()));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

/**
 * What the record step does with the start command and port fields, and
 * why: the target probed is the one stage 7 froze, so an api target is
 * probed as an api and a cli target is reported as one the host cannot
 * probe; blank fields mean nothing is started, and that is said as such
 * rather than as the plan having declared nothing.
 */
export function probeDecision(input: { readonly startCommand: string; readonly port: string; readonly frozenTarget: string | null }): {
  readonly targets: readonly { target: string; command: string; port: number }[];
  readonly skipped: string | null;
} {
  const command = input.startCommand.trim();
  const portNumber = Number(input.port.trim());
  if (command.length === 0 && input.port.trim().length === 0) {
    return { targets: [], skipped: "No target was started or probed: no start command and port were given when this attempt was recorded." };
  }
  if (command.length === 0) return { targets: [], skipped: "No target was started or probed: a port was given but no start command." };
  if (!Number.isInteger(portNumber) || portNumber <= 0 || portNumber > 65_535) {
    return { targets: [], skipped: `No target was started or probed: "${input.port.trim() || "(blank)"}" is not a port the host can wait on.` };
  }
  const target = input.frozenTarget?.trim() || "web";
  return { targets: [{ target, command, port: portNumber }], skipped: null };
}

const FINAL_TEXT_KEEP = 20_000;

/**
 * The build status as it stands: the supervisor's reply to the brief for
 * `attempt`, the newest recorded, or that it has not replied yet. The brief
 * is found by its subject and the reply by its threading, never by either
 * body. Null when no brief for that attempt was sent.
 */
export function supervisorStatus(
  messages: readonly ChatMessage[],
  attempt: number,
): { attempt: number; reply: ChatMessage | null } | null {
  const subject = appSubject("brief", String(attempt));
  const brief = messages.findLast((message) => message.author === "me" && message.subject === subject);
  if (!brief) return null;
  const { answeredBy } = pairReplies(messages);
  return { attempt, reply: messages.find((message) => message.author === "agent" && answeredBy.get(message.id) === brief.id) ?? null };
}

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
      ? `- ${input.probeSkipped ?? "No target was started or probed."}`
      : input.verification.targets.map((target) => `- ${target.target}: ${target.ranSuccessfully ? "responded" : "did not respond"} (${PROBE_RAN_ON}).`).join("\n");
  return [
    `Build attempt ${String(input.attempt)} has ended and its work is recorded. Write the build status from this record.`,
    ``,
    `## What the worker reported`,
    `- Worker: ${outcome.worker} (\`${outcome.command}\`), ${ended}; ${reported}.`,
    `- Ran from ${zonedTime(outcome.startedAt)} to ${zonedTime(outcome.endedAt)}.`,
    `- The interface gives a final text and an exit status and nothing else: no session, steering or checkpoint exists.`,
    ``,
    `### Final text`,
    finalText.trim().length > 0 ? finalText.trim() : "(the worker wrote nothing to stdout)",
    ...(outcome.stderrTail.trim().length > 0 ? [``, `### Last lines of stderr`, outcome.stderrTail.trim()] : []),
    ``,
    `## Evidence recorded`,
    `- Archive ${input.archive.fileName}, ${String(input.archive.sizeBytes)} bytes, sha256 ${input.archive.sha256}, recorded as attempt-${String(input.attempt)}.`,
    `- The archive holds ${String(input.archive.fileCount)} file${input.archive.fileCount === 1 ? "" : "s"}; any file count you give is this one.`,
    `- Deterministic checks: ${input.verification.complete ? "complete" : `incomplete — not verified: ${input.verification.failed.join(", ") || "(unnamed)"}`}.`,
    targets,
    ``,
    `## Cost approval forecast`,
    input.forecast?.trim()
      ? input.forecast.trim()
      : "No forecast could be read from the Cost approval estimate. Under \"Cost against forecast\", say the forecast is unknown rather than supplying one.",
    `The worker's own cost is not reported by its interface; say so if you cannot read it from its final text.`,
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
