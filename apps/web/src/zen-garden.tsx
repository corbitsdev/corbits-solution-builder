/**
 * The shell's busy indicator: a zen garden along the foot of the window.
 *
 * While the interface is doing something the person is waiting on, a small
 * figure rakes the sand from left to right and the raked lines appear behind
 * them; a caption says how long it has been. One place, the same every time,
 * apart from whichever control was pressed — the answer to an approval that
 * ran forty seconds with nothing but a 16px spinner inside its button to
 * show for it (#93).
 *
 * The strip is always mounted and grows from nothing, so its arrival is a
 * slide rather than a jump. It shows after one second of continuous work
 * and outlives short gaps between chained requests; both timings live in
 * `busy.ts`. Under reduced motion the figure stands still on raked sand and
 * only the clock moves.
 */
import { useEffect, useState } from "react";
import { clock } from "./pages/workspace/elapsed.tsx";
import { useBusyIndicator } from "./use-busy.ts";

function useSecondsSince(since: number | null): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (since === null) {
      setSeconds(0);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1_000)));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [since]);
  return seconds;
}

/** The figure: conical hat, a stride, and a rake trailing behind. */
function Raker() {
  return (
    <svg className="zen-raker-figure" viewBox="0 0 56 44" width="56" height="44" aria-hidden="true">
      <g className="zen-arm" fill="none" strokeLinecap="round">
        <line x1="31" y1="18" x2="25" y2="24" strokeWidth="2.2" />
        <line x1="25" y1="24" x2="9" y2="38" strokeWidth="1.6" />
        <line x1="7" y1="35.7" x2="11" y2="40.3" strokeWidth="1.6" />
        <line x1="7.5" y1="36.3" x2="6.5" y2="42" strokeWidth="1" />
        <line x1="9.2" y1="38.2" x2="8.5" y2="42" strokeWidth="1" />
        <line x1="10.8" y1="40" x2="10.5" y2="42" strokeWidth="1" />
      </g>
      <g className="zen-leg zen-leg-back" fill="none" strokeLinecap="round" strokeWidth="2.4">
        <line x1="30" y1="27" x2="25" y2="41" />
        <line x1="25" y1="41.5" x2="28.5" y2="41.5" />
      </g>
      <g className="zen-leg zen-leg-front" fill="none" strokeLinecap="round" strokeWidth="2.4">
        <line x1="30" y1="27" x2="35" y2="41" />
        <line x1="35" y1="41.5" x2="38.5" y2="41.5" />
      </g>
      <line className="zen-torso" x1="31" y1="16" x2="30" y2="27" strokeWidth="3" strokeLinecap="round" />
      <circle className="zen-head" cx="31" cy="12.5" r="3.5" />
      <polygon className="zen-hat" points="23,11 39,11 31,3" />
      <line className="zen-hat-brim" x1="21" y1="11" x2="41" y2="11" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ZenGarden() {
  const { visible, since } = useBusyIndicator();
  const seconds = useSecondsSince(visible ? since : null);
  return (
    <div className="zen-garden" data-visible={visible ? "" : undefined}>
      <div className="zen-garden-strip" aria-hidden="true">
        <div className="zen-sand" />
        <div className="zen-raked" />
        <span className="zen-stone zen-stone-a" />
        <span className="zen-stone zen-stone-b" />
        <div className="zen-raker">
          <Raker />
        </div>
      </div>
      <p className="zen-garden-caption">
        <span role="status" aria-live="polite">
          {visible ? "Working…" : null}
        </span>{" "}
        {visible ? (
          <span className="zen-garden-clock" role="timer" aria-live="off">
            {clock(seconds)}
          </span>
        ) : null}
      </p>
    </div>
  );
}
