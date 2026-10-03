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
 * first frame and only the clock moves. With the garden turned off in
 * Settings the strip never shows; `BusyLine` says the same in the composer.
 */
import { useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import {
  STRIP_KEY_STEP,
  STRIP_MIN_HEIGHT,
  clampStripHeight,
  draggedStripHeight,
  readStripHeight,
  writeStripHeight,
} from "./busy-strip-height.ts";
import { clock } from "./pages/workspace/elapsed.tsx";
import { useBusyIndicator } from "./use-busy.ts";
import { useZenGarden } from "./zen-garden-setting.ts";

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

export function useReducedMotion(): boolean {
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

/**
 * The strip's height as the person set it, or null for the default (#120).
 * A drag on the grip along the strip's top edge sets it; the arrow keys on
 * the grip do the same; a double-click lets it go. Held in browser storage
 * across reloads.
 */
function useStripHeight(): {
  height: number | null;
  resizing: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  reset: () => void;
} {
  const [height, setHeight] = useState<number | null>(() => readStripHeight());
  const [resizing, setResizing] = useState(false);
  const commit = (next: number | null) => {
    setHeight(next);
    writeStripHeight(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const strip = event.currentTarget.parentElement;
    if (!strip) return;
    event.preventDefault();
    const startHeight = strip.getBoundingClientRect().height;
    const startY = event.clientY;
    const grip = event.currentTarget;
    // Capture keeps the drag alive when the pointer leaves the grip; a
    // pointer that cannot be captured (already released, or synthetic)
    // still drags for as long as it stays over the grip.
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // See above.
    }
    setResizing(true);
    let latest = startHeight;
    const onMove = (move: globalThis.PointerEvent) => {
      latest = draggedStripHeight(startHeight, startY, move.clientY, window.innerHeight);
      setHeight(latest);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      setResizing(false);
      commit(latest);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = height ?? event.currentTarget.parentElement?.getBoundingClientRect().height ?? STRIP_MIN_HEIGHT;
    if (event.key === "ArrowUp") commit(clampStripHeight(current + STRIP_KEY_STEP, window.innerHeight));
    else if (event.key === "ArrowDown") commit(clampStripHeight(current - STRIP_KEY_STEP, window.innerHeight));
    else if (event.key === "Home") commit(null);
    else return;
    event.preventDefault();
  };
  return { height, resizing, onPointerDown, onKeyDown, reset: () => commit(null) };
}

export function ZenGarden() {
  const { visible, since, label } = useBusyIndicator();
  const seconds = useSecondsSince(visible ? since : null);
  const still = useReducedMotion();
  const size = useStripHeight();
  const shown = useZenGarden();
  if (!shown) return null;
  return (
    <div
      className="zen-garden"
      data-visible={visible ? "" : undefined}
      data-resizing={size.resizing ? "" : undefined}
      style={size.height !== null ? ({ "--zen-height": `${size.height}px` } as CSSProperties) : undefined}
    >
      <div className="zen-garden-strip">
        {/* The grip: a few pixels along the top edge where the pointer
            becomes a resize cursor. A separator for assistive technology,
            with the arrow keys and Home as its keyboard. */}
        {visible ? (
          <div
            className="zen-garden-grip"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Busy strip height"
            aria-valuenow={size.height ?? undefined}
            aria-valuemin={STRIP_MIN_HEIGHT}
            tabIndex={0}
            title="Drag to change the height; double-click for the default"
            onPointerDown={size.onPointerDown}
            onKeyDown={size.onKeyDown}
            onDoubleClick={size.reset}
          />
        ) : null}
        {visible ? <GardenFilm still={still} /> : null}
      </div>
      <div className="zen-garden-caption">
        <p className="zen-garden-caption-line">
          <span role="status" aria-live="polite">
            {visible ? "Working…" : null}
          </span>{" "}
          {visible ? (
            <span className="zen-garden-clock" role="timer" aria-live="off">
              {clock(seconds)}
            </span>
          ) : null}
        </p>
        {/* What the work is, when it says: a specialist's turn names the
            specialist and the stage's task (#113). Its own live region, so
            a change of task is announced once and the clock never is. */}
        <p className="zen-garden-doing" role="status" aria-live="polite">
          {visible && label ? label : null}
        </p>
      </div>
    </div>
  );
}

/** The strip's caption as one quiet line, for the composer to hold while
 *  the zen garden is turned off; nothing while it is on, or nothing is busy. */
export function BusyLine() {
  const { visible, since, label } = useBusyIndicator();
  const seconds = useSecondsSince(visible ? since : null);
  const garden = useZenGarden();
  if (garden || !visible) return null;
  return (
    <p className="busy-line" role="status" aria-live="polite">
      <span className="thinking">{label ?? "Working…"}</span>{" "}
      <span className="busy-line-clock" role="timer" aria-live="off">
        {clock(seconds)}
      </span>
    </p>
  );
}
