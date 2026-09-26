import { useEffect, useState } from "react";
import {
  IDLE,
  INDICATOR_TIMING,
  beginBusy,
  busyCount,
  indicatorVisible,
  nextDeadline,
  stepIndicator,
  subscribeBusy,
  type IndicatorState,
  type IndicatorTiming,
} from "./busy.ts";

/**
 * Counts the surface as busy for as long as `active` holds. The one hook a
 * screen needs: hand it the flag it already keeps for its own spinner or
 * "Loading…" line and the shell's indicator follows.
 */
export function useBusyWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return beginBusy();
  }, [active]);
}

/**
 * Whether the shell's busy indicator is up, and since when. Drives the
 * timing machine in `busy.ts` off the shared count: a step on every count
 * change, and one more when the machine says a deadline has passed.
 */
export function useBusyIndicator(timing: IndicatorTiming = INDICATOR_TIMING): {
  visible: boolean;
  since: number | null;
} {
  const [state, setState] = useState<IndicatorState>(IDLE);

  useEffect(() => {
    const step = () => setState((current) => stepIndicator(current, busyCount(), Date.now(), timing));
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
  };
}
