/**
 * How a design is framed for reading: each phone screen in an iPhone of its
 * own (#101), each desktop screen in a browser window (#264), and the rest
 * of the document in the pane. "As designed" follows the designer's own
 * surface marks; the selector can put every screen in a phone or in a
 * desktop window instead, or show the design plain in the pane.
 */
import { useEffect, useRef, useState } from "react";
import { DESKTOP_WINDOW, DesktopFrame } from "./desktop-frame.tsx";
import { fitDesignScale, measureDesignWidth } from "./design-measure.ts";
import { IPHONE_17_PRO, IPhoneFrame } from "./iphone-frame.tsx";
import { splitSurfaces, type PhoneSurface } from "./phone-surfaces.ts";

export type FrameMode = "auto" | "phone" | "desktop" | "pane";

export type FramedDesign = {
  readonly phones: readonly PhoneSurface[];
  readonly desktops: readonly PhoneSurface[];
  readonly main: string | null;
};

export function framedDesign(content: string, mode: FrameMode, title: string): FramedDesign {
  if (mode === "pane") return { phones: [], desktops: [], main: content };
  const split = splitSurfaces(content);
  const screens = [...split.desktops, ...split.phones];
  if (mode === "phone" || mode === "desktop") {
    // A forced frame is one frame per screen, whatever surface the designer
    // marked it for (#417, #714): the stage 4 prompt asks each screen to lay
    // out at the phone width too, and a desktop window shows a phone screen
    // at its full width. Picking a device never stacks every screen into one
    // frame; only an unmarked design goes in whole.
    const framed = screens.length > 0 ? screens : [{ id: "whole", title, html: content }];
    const main = screens.length > 0 ? split.main : null;
    return mode === "phone" ? { phones: framed, desktops: [], main } : { phones: [], desktops: framed, main };
  }
  if (screens.length > 0) return split;
  return { phones: [], desktops: [], main: content };
}

export function FrameSelect({ value, onChange }: { value: FrameMode; onChange: (mode: FrameMode) => void }) {
  return (
    <select aria-label="Frame" value={value} onChange={(event) => onChange(event.target.value as FrameMode)}>
      <option value="auto">Frame: as designed</option>
      <option value="desktop">{DESKTOP_WINDOW.name}</option>
      <option value="phone">{IPHONE_17_PRO.name}</option>
      <option value="pane">Pane</option>
    </select>
  );
}

/** A design's natural width at a viewport `at` wide, measured once per document; null until known or when it cannot be. */
function useNaturalWidth(html: string | null, at: number): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    setWidth(null);
    if (html === null || at <= 0) return;
    let cancelled = false;
    void measureDesignWidth(html, at).then((measured) => {
      if (!cancelled) setWidth(measured);
    });
    return () => {
      cancelled = true;
    };
  }, [html, at]);
  return width;
}

/** The element's rendered width, followed as it changes; 0 until measured. */
function useBoxWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The pane's frame, fitted (#268): a design that lays itself out wider than
 * the pane is drawn at its own width and scaled down to fit, so nothing is
 * cut off or scrolled away; one that fits is shown as it always was, in
 * the plain frame. The height stays the pane frame's own; the scaled
 * document gets proportionally more of its page in view.
 */
export function FittedPaneFrame({
  html,
  frameKey,
  title,
  paneClassName,
  registerFrame,
}: {
  html: string;
  frameKey: string;
  title: string;
  paneClassName: string;
  registerFrame?: (id: string, element: HTMLIFrameElement | null) => void;
}) {
  const [box, available] = useBoxWidth();
  const natural = useNaturalWidth(html, available);
  const scale = fitDesignScale(natural, available);
  const frame = (
    <iframe
      key={frameKey}
      ref={(element) => registerFrame?.("main", element)}
      className={scale < 1 ? "design-fit-frame" : paneClassName}
      title={title}
      srcDoc={html}
      sandbox=""
      style={
        scale < 1 && natural !== null
          ? { background: "#fff", width: `${String(natural)}px`, height: `${String(100 / scale)}%`, transform: `scale(${String(scale)})` } // not-our-surface: a generated mockup is its own page
          : { background: "#fff" } // not-our-surface: a generated mockup is its own page
      }
    />
  );
  return (
    <div ref={box} className={scale < 1 ? `${paneClassName} design-fit` : "design-fit-box"}>
      {frame}
    </div>
  );
}

/** One desktop screen in its window, the window as wide as the screen lays itself out when that is more than 1280 (#268). */
function DesktopScreen({
  screen,
  frameKey,
  registerFrame,
}: {
  screen: PhoneSurface;
  frameKey: string;
  registerFrame?: (id: string, element: HTMLIFrameElement | null) => void;
}) {
  const natural = useNaturalWidth(screen.html, DESKTOP_WINDOW.width);
  const logicalWidth = Math.max(DESKTOP_WINDOW.width, natural ?? 0);
  return (
    <DesktopFrame key={`${frameKey}:${screen.id}`} title={screen.title} logicalWidth={logicalWidth}>
      <iframe
        ref={(element) => registerFrame?.(screen.id, element)}
        className="design-desktop-screen"
        title={`${screen.title}, in a ${DESKTOP_WINDOW.name.toLowerCase()}`}
        srcDoc={screen.html}
        sandbox=""
      />
    </DesktopFrame>
  );
}

/**
 * One screen in a phone. A screen that lays itself out wider than the phone
 * is drawn at its own width and scaled to fit, as the pane does (#268):
 * cut at the right edge, its overflow could not be seen at all.
 */
function PhoneScreen({
  screen,
  registerFrame,
}: {
  screen: PhoneSurface;
  registerFrame?: (id: string, element: HTMLIFrameElement | null) => void;
}) {
  const natural = useNaturalWidth(screen.html, IPHONE_17_PRO.width);
  const scale = fitDesignScale(natural, IPHONE_17_PRO.width);
  return (
    <IPhoneFrame title={screen.title}>
      <iframe
        ref={(element) => registerFrame?.(screen.id, element)}
        className={scale < 1 ? "design-fit-frame" : "design-phone-screen"}
        title={`${screen.title}, on an ${IPHONE_17_PRO.name}`}
        srcDoc={screen.html}
        sandbox=""
        style={
          scale < 1 && natural !== null
            ? { width: `${String(natural)}px`, height: `${String(100 / scale)}%`, transform: `scale(${String(scale)})` }
            : undefined
        }
      />
    </IPhoneFrame>
  );
}

export function DesignFrames({
  framed,
  frameKey,
  title,
  paneClassName,
  registerFrame,
}: {
  framed: FramedDesign;
  /** Changes when the document does, so each document gets a frame of its own. */
  frameKey: string;
  /** The pane frame's accessible title. */
  title: string;
  paneClassName: string;
  /** Called with each frame as it mounts (and null as it unmounts). */
  registerFrame?: (id: string, element: HTMLIFrameElement | null) => void;
}) {
  return (
    <>
      {framed.desktops.length > 0 ? (
        <div className="desktop-rack" aria-label="Desktop screens">
          {framed.desktops.map((screen) => (
            <DesktopScreen key={`${frameKey}:${screen.id}`} screen={screen} frameKey={frameKey} {...(registerFrame ? { registerFrame } : {})} />
          ))}
        </div>
      ) : null}
      {framed.phones.length > 0 ? (
        <div className="phone-rack" aria-label="Phone screens">
          {framed.phones.map((phone) => (
            <PhoneScreen key={`${frameKey}:${phone.id}`} screen={phone} {...(registerFrame ? { registerFrame } : {})} />
          ))}
        </div>
      ) : null}
      {framed.main !== null ? (
        <FittedPaneFrame
          key={frameKey}
          html={framed.main}
          frameKey={frameKey}
          title={title}
          paneClassName={paneClassName}
          {...(registerFrame ? { registerFrame } : {})}
        />
      ) : null}
    </>
  );
}
