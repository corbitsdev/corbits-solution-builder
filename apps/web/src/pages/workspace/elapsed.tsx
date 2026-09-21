import { useEffect, useState } from "react";

/**
 * How long a stage's draft usually takes, in the person's terms. A design is
 * one long document at a 32,000-token default and takes minutes; every other
 * stage's draft is a page or two.
 */
export function draftEstimate(stage: number): string {
  return stage === 4
    ? "A design usually takes five to ten minutes."
    : "A draft usually takes a minute or two.";
}

export function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Milliseconds since `since`, ticking every second. `since` is a recorded
 * timestamp — the outgoing mail's, not an inferred run start — so the count
 * is the same after a reload as it was before it.
 */
export function useElapsedMs(since?: string | null): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const parsed = since ? Date.parse(since) : Number.NaN;
    const started = Number.isNaN(parsed) ? Date.now() : parsed;
    const tick = () => setMs(Math.max(0, Date.now() - started));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [since]);
  return ms;
}

/**
 * Counts up from when the wait began, beside how long it usually takes. A
 * spinner says "working"; this says "for how long, and how long is normal",
 * which is what a person staring at a blank pane for six minutes wants to
 * know. The clock is kept out of any live region so a screen reader is not
 * told the time every second.
 *
 * `stage` is optional so callers that do not know the stage (the thread view,
 * the design page) still render the generic estimate; the preparing view
 * passes its stage for the stage-specific copy.
 */
export function Elapsed({ stage, since }: { stage?: number; since?: string | null }) {
  const seconds = Math.floor(useElapsedMs(since) / 1_000);
  return (
    <p className="elapsed">
      <span className="elapsed-clock" role="timer" aria-live="off">
        {clock(seconds)}
      </span>{" "}
      elapsed. {draftEstimate(stage ?? 0)}
    </p>
  );
}
