/**
 * The shell's busy indicator: a zen garden along the foot of the window.
 *
 * While the interface is doing something the person is waiting on, a strip
 * along the bottom shows a garden being raked — a short film, looped — with
 * a caption saying how long it has been. One place, the same every time,
 * apart from whichever control was pressed (#93, #107).
 *
 * The strip is always mounted and grows from nothing, so its arrival is a
 * slide rather than a jump; the film is mounted only while the strip is up,
 * so nothing loads or plays behind a closed strip. It shows after a second
 * of continuous work and outlives short gaps between chained requests; both
 * timings live in `busy.ts`. Under reduced motion the film holds on its
 * first frame and only the clock moves.
 */
import { useEffect, useState } from "react";
import { clock } from "./pages/workspace/elapsed.tsx";
import { useBusyIndicator } from "./use-busy.ts";

/** Served from `apps/web/public`, beside the bundle, so the film ships with it. */
export const ZEN_GARDEN_VIDEO = "/zen-garden.mp4";
export const ZEN_GARDEN_POSTER = "/zen-garden-poster.jpg";

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

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && "matchMedia" in window && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** The film. Muted through the element as well as the attribute: a browser
 *  autoplays only a muted video, and React sets `muted` as a property that
 *  is not always in place before playback is attempted. */
function GardenFilm({ still }: { still: boolean }) {
  return (
    <video
      className="zen-garden-video"
      ref={(element) => {
        if (element) {
          element.muted = true;
          element.defaultMuted = true;
        }
      }}
      src={ZEN_GARDEN_VIDEO}
      poster={ZEN_GARDEN_POSTER}
      autoPlay={!still}
      loop
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}

export function ZenGarden() {
  const { visible, since } = useBusyIndicator();
  const seconds = useSecondsSince(visible ? since : null);
  const still = useReducedMotion();
  return (
    <div className="zen-garden" data-visible={visible ? "" : undefined}>
      <div className="zen-garden-strip" aria-hidden="true">
        {visible ? <GardenFilm still={still} /> : null}
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
