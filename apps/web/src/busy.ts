/**
 * One count of everything the interface is doing on the person's behalf.
 *
 * Every long action already marks its own control — a button's spinner, a
 * "Loading…" line — and each of those is invisible from anywhere else on the
 * screen. An approval that takes forty seconds looked like a hang because the
 * only sign of it was a 16px spinner inside the button that was pressed
 * (#93). This module is the one place those marks add up, so a single
 * indicator can say "busy" for all of them.
 *
 * Deliberately not wired to the fetch layer: the shell re-reads status and
 * the project list every five seconds, and a slow poll would raise the
 * indicator with nobody having asked for anything. What counts is work a
 * person is waiting on — a pressed control, a pane that has not filled yet, a
 * specialist turn in flight — registered by the surface that shows it.
 */

type Listener = (count: number) => void;

let count = 0;
let nextToken = 0;
/** The labelled work in flight, in the order it began. */
const labels = new Map<number, string>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener(count);
}

/** How many pieces of work are in flight right now. */
export function busyCount(): number {
  return count;
}

/**
 * What the newest labelled piece of work says it is doing, or null: the
 * indicator shows it under the clock (#113). Most work is unlabelled (a
 * button doing its thing); a specialist's turn names the specialist.
 */
export function busyLabel(): string | null {
  let latest: string | null = null;
  for (const label of labels.values()) latest = label;
  return latest;
}

/**
 * Registers one piece of work, with what it is doing when that is worth
 * saying. Returns its release; calling that more than once is harmless, so
 * a `finally` and an effect cleanup can both hold it.
 */
export function beginBusy(label?: string): () => void {
  count += 1;
  const token = nextToken++;
  if (label) labels.set(token, label);
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    count -= 1;
    labels.delete(token);
    notify();
  };
}

/** Called with the new count on every change. Returns the unsubscribe. */
export function subscribeBusy(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---- When the indicator shows ---- */

/**
 * The indicator's own state, kept apart from the count so the timing can be
 * reasoned about (and tested) without a clock or a component.
 *
 * - `idle`: nothing in flight, nothing shown.
 * - `arming`: work began at `since` and is not yet shown. Work that finishes
 *   inside the grace period never shows — a 200ms save should not raise a
 *   garden and take it away again.
 * - `shown`: on screen, counting from `since`.
 * - `lingering`: the count hit zero at `idleAt` and the indicator is still
 *   up. An approval is a chain of requests with gaps between them; without
 *   this the garden would blink on every gap.
 */
export type IndicatorState =
  | { readonly phase: "idle" }
  | { readonly phase: "arming"; readonly since: number }
  | { readonly phase: "shown"; readonly since: number }
  | { readonly phase: "lingering"; readonly since: number; readonly idleAt: number };

export type IndicatorTiming = {
  /** Continuous work shorter than this never shows. The product rule is one second. */
  readonly showAfterMs: number;
  /** How long a shown indicator outlives the count reaching zero. */
  readonly lingerMs: number;
};

export const INDICATOR_TIMING: IndicatorTiming = { showAfterMs: 1_000, lingerMs: 600 };

export const IDLE: IndicatorState = { phase: "idle" };

/**
 * The next state given the current count and the time. Pure: the caller
 * runs it on every count change and whenever `nextDeadline` says to.
 */
export function stepIndicator(
  state: IndicatorState,
  count: number,
  now: number,
  timing: IndicatorTiming = INDICATOR_TIMING,
): IndicatorState {
  switch (state.phase) {
    case "idle":
      return count > 0 ? { phase: "arming", since: now } : state;
    case "arming":
      if (count === 0) return IDLE;
      return now - state.since >= timing.showAfterMs ? { phase: "shown", since: state.since } : state;
    case "shown":
      return count === 0 ? { phase: "lingering", since: state.since, idleAt: now } : state;
    case "lingering":
      if (count > 0) return { phase: "shown", since: state.since };
      return now - state.idleAt >= timing.lingerMs ? IDLE : state;
  }
}

/**
 * Milliseconds until the state would change on its own, or null when only a
 * count change can move it.
 */
export function nextDeadline(
  state: IndicatorState,
  now: number,
  timing: IndicatorTiming = INDICATOR_TIMING,
): number | null {
  switch (state.phase) {
    case "arming":
      return Math.max(0, state.since + timing.showAfterMs - now);
    case "lingering":
      return Math.max(0, state.idleAt + timing.lingerMs - now);
    default:
      return null;
  }
}

export function indicatorVisible(state: IndicatorState): boolean {
  return state.phase === "shown" || state.phase === "lingering";
}
