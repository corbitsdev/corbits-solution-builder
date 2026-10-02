/**
 * Whether a stage's specialist is working, read from its run (#445).
 *
 * A specialist is one mail-triggered, unbounded-turn agent step in a
 * workflow run. The run's own event log says what it is doing: a step
 * starts (`StepStarted`), parks for its next mail (`SignalAwaited`), takes a
 * delivered mail (`SignalReceived`) and works until it parks again, and ends
 * (`StepCompleted`, `RunCompleted`, `RunFailed`). The chat used to infer
 * "working" from a person turn with no reply in the mailbox, which cannot
 * tell "still being answered" from "the reply was dropped" (#438); this
 * reads the fact instead. The newest of those events decides, and an event
 * log that carries none of them, or no run at all, is `unknown`, never a
 * guess.
 */

export type SpecialistRunState = "working" | "idle" | "ended" | "unknown";

/** The run's state and when it last said so (the deciding event's `at`), or null when nothing in the log says. */
export type SpecialistRun = { readonly state: SpecialistRunState; readonly at: string | null };

export const UNKNOWN_RUN: SpecialistRun = { state: "unknown", at: null };

export type RunEventLike = { readonly seq: number; readonly type: string; readonly body: Record<string, unknown> };

const WORKING = new Set(["StepStarted", "SignalReceived"]);
const IDLE = new Set(["SignalAwaited"]);
const ENDED = new Set(["StepCompleted", "StepFailed", "RunCompleted", "RunFailed", "RunCancelled"]);

/** The run's state from its events, in any order; the highest `seq` that says something decides. */
export function runStateOf(events: readonly RunEventLike[]): SpecialistRun {
  let newest: { seq: number; run: SpecialistRun } | null = null;
  for (const event of events) {
    const state: SpecialistRunState | null = WORKING.has(event.type)
      ? "working"
      : IDLE.has(event.type)
        ? "idle"
        : ENDED.has(event.type)
          ? "ended"
          : null;
    if (state === null) continue;
    if (newest === null || event.seq > newest.seq) {
      const at = typeof event.body["at"] === "string" ? event.body["at"] : null;
      newest = { seq: event.seq, run: { state, at } };
    }
  }
  return newest?.run ?? UNKNOWN_RUN;
}

/** A deployment's top-level run ids: those with no `__` iteration suffix. */
export function topLevelRunIds(runIds: readonly string[]): string[] {
  return runIds.filter((id) => !id.includes("__"));
}

/**
 * Whether the chat shows the specialist as working. The run's word first:
 * working is working. Parked or ended, the person's newest turn still
 * counts as in flight while it is newer than the run's last word, since the
 * mail has not reached the run yet; a park that came after the turn means
 * the run answered (or the reply was dropped), and the chat is idle either
 * way (#438). With no run to read, the mailbox decides alone.
 */
export function specialistBusy(run: SpecialistRun, pendingAt: string | null): boolean {
  if (run.state === "working") return true;
  if (pendingAt === null) return false;
  if (run.state === "unknown" || run.at === null) return true;
  return Date.parse(pendingAt) > Date.parse(run.at);
}
