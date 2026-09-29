/**
 * A browser window around a desktop screen (#264), the way `iphone-frame.tsx`
 * puts a phone screen in a phone. The window is drawn at its own logical
 * size, 1280 by 800, so the design lays out as a desktop page would, and the
 * whole window is scaled down to the width it is shown in: a desktop design
 * is seen in landscape at its real proportions, never squeezed into the pane.
 * The chrome — title bar, traffic lights, address pill — is CSS only.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export const DESKTOP_WINDOW = { name: "Desktop window", width: 1280, height: 800 } as const;

/** The scale that fits `width` logical pixels into the element's box; 1 until measured. */
export function fitScale(available: number, width: number): number {
  if (!Number.isFinite(available) || available <= 0) return 1;
  return Math.min(1, available / width);
}

export function DesktopFrame({ title, children }: { title: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const update = () => setScale(fitScale(element.clientWidth, DESKTOP_WINDOW.width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <figure className="desktop-window" aria-label={`${title}, in a ${DESKTOP_WINDOW.name.toLowerCase()}`}>
      <div className="desktop-chrome" aria-hidden="true">
        <span className="desktop-lights">
          <i />
          <i />
          <i />
        </span>
        <span className="desktop-address">{title}</span>
      </div>
      <div ref={box} className="desktop-scale" style={{ height: `${String(Math.round(DESKTOP_WINDOW.height * scale))}px` }}>
        <div
          className="desktop-viewport"
          style={{ width: `${String(DESKTOP_WINDOW.width)}px`, height: `${String(DESKTOP_WINDOW.height)}px`, transform: `scale(${String(scale)})` }}
        >
          {children}
        </div>
      </div>
      <figcaption className="desktop-caption">{title}</figcaption>
    </figure>
  );
}
