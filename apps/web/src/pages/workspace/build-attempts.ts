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
  /** True when this record replaces an earlier one of the same attempt (#727). */
  readonly repackaged?: boolean;
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
    input.repackaged
      ? `Build attempt ${String(input.attempt)} has ended and its work is recorded again, replacing the earlier record of this attempt. Write the build status from this record.`
      : `Build attempt ${String(input.attempt)} has ended and its work is recorded. Write the build status from this record.`,
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

/** The first line of a progress brief, by which later polls recognise the ones already sent. */
const PROGRESS_BRIEF_LEAD = "Build attempt";
const PROGRESS_BRIEF_MARK = "is still running";

/** How much of the worker's log the supervisor is shown in a progress brief. */
const PROGRESS_LOG_KEEP = 6_000;

/** How often, while the worker runs, the supervisor is briefed on its progress (#695). */
export const PROGRESS_BRIEF_INTERVAL_MS = 10 * 60_000;
/** The first brief waits for the worker to have reported something. */
export const FIRST_PROGRESS_BRIEF_AFTER_MS = 2 * 60_000;

/**
 * The latest turn the worker has reported, read off its own `── turn N`
 * lines in the log; null before the first. The number is the worker's, not
 * an inference: the line is written from its hook's report.
 */
export function latestTurn(log: string): number | null {
  let last: number | null = null;
  for (const match of log.matchAll(/^── turn (\d+) · /gm)) last = Number(match[1]);
  return last;
}

/** The tool calls the worker has reported so far, summed over its turn lines. */
export function toolCallsSoFar(log: string): number {
  let total = 0;
  for (const match of log.matchAll(/^── turn \d+ · (\d+) tool call/gm)) total += Number(match[1]);
  return total;
}

/**
 * The brief the supervisor is mailed while an attempt runs (#695): how
 * long the worker has been at it, what it has reported so far, and the last
 * stretch of its own turn lines. Said as it is, with what is not yet known
 * said as not known, so the interim status rests on the record.
 */
export function composeProgressBrief(input: {
  readonly attempt: number;
  readonly startedAt: string;
  readonly now: string;
  readonly log: string;
  readonly worker?: string | null;
}): string {
  const turn = latestTurn(input.log);
  const minutes = Math.max(0, Math.round((Date.parse(input.now) - Date.parse(input.startedAt)) / 60_000));
  const tail = input.log.length > PROGRESS_LOG_KEEP ? `…${input.log.slice(-PROGRESS_LOG_KEEP)}` : input.log;
  return [
    `${PROGRESS_BRIEF_LEAD} ${String(input.attempt)} ${PROGRESS_BRIEF_MARK}; write an interim build status from this record, as of turn ${turn === null ? "none yet" : String(turn)} at ${zonedTime(input.now)}.`,
    ``,
    `## What the worker has reported so far`,
    `- Worker: ${input.worker ?? "the coding agent"}, running since ${zonedTime(input.startedAt)} (${String(minutes)} minute${minutes === 1 ? "" : "s"}).`,
    `- ${turn === null ? "No turn has been reported yet." : `${String(turn)} turn${turn === 1 ? "" : "s"} and ${String(toolCallsSoFar(input.log))} tool call${toolCallsSoFar(input.log) === 1 ? "" : "s"} reported through its hook.`}`,
    `- The attempt has not ended: there is no exit status, no final text, and no archive. Nothing is recorded or passed yet.`,
    `- The interface gives these turn lines, a final text and an exit status when it ends, and nothing else: no session, steering or checkpoint exists.`,
    ``,
    `### The worker's last turn lines`,
    tail.trim().length > 0 ? tail.trim() : "(nothing yet)",
    ``,
    `## How to write it`,
    `This status is interim. Open "In short" with the turn and time it is as of, and that the worker is still running. Under "What the worker reported", say only what the turn lines show the worker doing; a task it names is a task it is working on, not one that is done. Under "Evidence collected", say none is recorded until the attempt ends. Every required check is still unknown. Keep the headings as usual.`,
  ].join("\n");
}

/** Whether a message is a progress brief for `attempt`, and which turn it was as of. */
export function progressBriefOf(message: Pick<ChatMessage, "author" | "body">, attempt: number): { turn: number | null } | null {
  if (message.author !== "me") return null;
  const lead = `${PROGRESS_BRIEF_LEAD} ${String(attempt)} ${PROGRESS_BRIEF_MARK};`;
  if (!message.body.startsWith(lead)) return null;
  const match = /as of turn (\d+|none yet) at /.exec(message.body.split("\n")[0] ?? "");
  return { turn: match && match[1] !== "none yet" ? Number(match[1]) : null };
}

/**
 * Whether it is time to brief the supervisor on a running attempt (#695).
 * The thread is the memory: the last brief for this attempt, and whether it
 * was answered, are read from it, so a reload never briefs twice. The first
 * brief waits for the worker's first turn; a later one waits the interval,
 * for the worker to have reported a further turn, and for the supervisor's
 * answer to the last one (or twice the interval, if none came).
 */
export function progressBriefDue(input: {
  readonly messages: readonly Pick<ChatMessage, "author" | "body" | "at">[];
  readonly attempt: number;
  readonly startedAt: string;
  readonly turn: number | null;
  readonly now: string;
  readonly intervalMs?: number;
}): boolean {
  const interval = input.intervalMs ?? PROGRESS_BRIEF_INTERVAL_MS;
  const now = Date.parse(input.now);
  if (input.turn === null) return false;
  let lastIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (progressBriefOf(input.messages[index]!, input.attempt)) {
      lastIndex = index;
      break;
    }
  }
  if (lastIndex < 0) return now - Date.parse(input.startedAt) >= FIRST_PROGRESS_BRIEF_AFTER_MS;
  const last = input.messages[lastIndex]!;
  const since = now - Date.parse(last.at);
  if (since < interval) return false;
  const lastTurn = progressBriefOf(last, input.attempt)?.turn ?? null;
  if (lastTurn !== null && input.turn <= lastTurn) return false;
  const answered = input.messages.slice(lastIndex + 1).some((message) => message.author === "agent");
  return answered || since >= interval * 2;
}

/**
 * How fresh the status in view is, against the attempt in view (#695):
 * interim as of a turn, written on an attempt's record, or written before
 * the attempt started. The status is the supervisor's latest reply; what
 * it answers is the "me" message before it.
 */
export function statusFreshness(
  messages: readonly Pick<ChatMessage, "id" | "author" | "body" | "at">[],
  status: Pick<ChatMessage, "id" | "at">,
  attempt: Pick<BuildAttempt, "attempt" | "startedAt" | "state"> | null,
): string | null {
  const index = messages.findIndex((message) => message.id === status.id);
  const asked = index > 0 ? [...messages.slice(0, index)].reverse().find((message) => message.author === "me") : undefined;
  if (asked) {
    const brief = attempt ? progressBriefOf(asked, attempt.attempt) : null;
    if (brief) return `interim, as of turn ${brief.turn === null ? "none" : String(brief.turn)} · ${zonedTime(status.at)}`;
    const recorded = /^Build attempt (\d+) has ended/.exec(asked.body);
    if (recorded) return `on attempt ${recorded[1]}'s record · ${zonedTime(status.at)}`;
  }
  if (attempt?.startedAt && Date.parse(status.at) < Date.parse(attempt.startedAt)) {
    return `written before attempt ${String(attempt.attempt)} started · ${zonedTime(status.at)}`;
  }
  return zonedTime(status.at);
}

/**
 * The one folder an archive unpacks into, read off its manifest (#727):
 * null when the manifest names none, which is every archive made before
 * #699, whose files sit at the archive root.
 */
export function archiveRootOf(manifestJson: string): string | null {
  try {
    const parsed = JSON.parse(manifestJson) as { archive?: { root?: unknown } };
    const root = parsed.archive?.root;
    return typeof root === "string" && root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** The manifest written beside an archive: same attempt variant, newest. */
export function manifestOf(nodes: readonly ArtifactNode[], archive: Pick<ArtifactNode, "variant">): ArtifactNode | null {
  const candidates = nodes.filter((node) => node.kind === "delivery_manifest" && node.stage === 8 && node.variant === archive.variant && node.supersededByNodeId === null);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, node) => (node.createdAt > latest.createdAt ? node : latest));
}

/**
 * How an archive unpacks, for its caption: the folder its manifest names,
 * null for none, undefined while the manifest is being read.
 */
export function useArchiveRoot(tenantId: string, nodes: readonly ArtifactNode[], archive: Pick<ArtifactNode, "variant">): string | null | undefined {
  const manifest = manifestOf(nodes, archive);
  const manifestId = manifest?.id ?? null;
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!manifestId) {
      setRoot(null);
      return;
    }
    setRoot(undefined);
    api
      .artifactContent(tenantId, manifestId)
      .then((result) => {
        if (!cancelled) setRoot(archiveRootOf(result.content));
      })
      .catch(() => {
        if (!cancelled) setRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, manifestId]);
  return root;
}
