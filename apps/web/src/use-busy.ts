import { useEffect, useState } from "react";
import {
  IDLE,
  INDICATOR_TIMING,
  beginBusy,
  busyCount,
  busyLabel,
  indicatorVisible,
  nextDeadline,
  stepIndicator,
  subscribeBusy,
  type IndicatorState,
  type IndicatorTiming,
} from "./busy.ts";

/**
 * Counts the surface as busy for as long as `active` holds, saying what it
 * is doing when `label` is given. The one hook a screen needs: hand it the
 * flag it already keeps for its own spinner or "Loading…" line and the
 * shell's indicator follows.
 */
export function useBusyWhile(active: boolean, label?: string): void {
  useEffect(() => {
    if (!active) return;
    return beginBusy(label);
  }, [active, label]);
}

/**
 * Whether the shell's busy indicator is up, and since when. Drives the
 * timing machine in `busy.ts` off the shared count: a step on every count
 * change, and one more when the machine says a deadline has passed.
 */
export function useBusyIndicator(timing: IndicatorTiming = INDICATOR_TIMING): {
  visible: boolean;
  since: number | null;
  /** What the newest labelled work says it is doing, while any is in flight. */
  label: string | null;
} {
  const [state, setState] = useState<IndicatorState>(IDLE);
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const step = () => {
      setState((current) => stepIndicator(current, busyCount(), Date.now(), timing));
      setLabel(busyLabel());
    };
    step();
    return subscribeBusy(step);
  }, [timing]);

  useEffect(() => {
    const wait = nextDeadline(state, Date.now(), timing);
    if (wait === null) return;
    const timer = setTimeout(
      () => setState((current) => stepIndicator(current, busyCount(), Date.now(), timing)),
      wait,
    );
    return () => clearTimeout(timer);
  }, [state, timing]);

  return {
    visible: indicatorVisible(state),
    since: state.phase === "idle" ? null : state.since,
    label,
  };
}
