import { useEffect, useState } from "react";

export function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Counts from the recorded outgoing message. It says nothing about what the
 * specialist is doing; the clock is outside a live region so a screen reader
 * is not told the time every second.
 */
export function Elapsed({ since }: { since?: string | null }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    // The timestamp is the outgoing mail's timestamp, not an inferred run
    // start time.
    const parsed = since ? Date.parse(since) : Number.NaN;
    const started = Number.isNaN(parsed) ? Date.now() : parsed;
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [since]);
  return (
    <p className="elapsed">
      <span className="elapsed-clock" role="timer" aria-live="off">
        {clock(seconds)}
      </span>{" "}
      since the recorded message.
    </p>
  );
}
