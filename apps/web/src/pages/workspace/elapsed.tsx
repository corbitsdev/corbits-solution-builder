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
 * Counts up from when the wait began, beside how long it usually takes. A
 * spinner says "working"; this says "for how long, and how long is normal",
 * which is what a person staring at a blank pane for six minutes wants to
 * know. The clock is kept out of any live region so a screen reader is not
 * told the time every second.
 */
export function Elapsed({ stage }: { stage: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="elapsed">
      <span className="elapsed-clock" role="timer" aria-live="off">
        {clock(seconds)}
      </span>{" "}
      elapsed. {draftEstimate(stage)}
    </p>
  );
}
