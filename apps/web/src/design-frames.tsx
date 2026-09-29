/**
 * How a design is framed for reading: each phone screen in an iPhone of its
 * own (#101), each desktop screen in a browser window (#264), and the rest
 * of the document in the pane. "As designed" follows the designer's own
 * surface marks; the selector can force a whole design into a phone or a
 * desktop window, or show it plain in the pane.
 */
import { DESKTOP_WINDOW, DesktopFrame } from "./desktop-frame.tsx";
import { IPHONE_17_PRO, IPhoneFrame } from "./iphone-frame.tsx";
import { splitPhoneSurfaces, splitSurfaces, type PhoneSurface } from "./phone-surfaces.ts";

export type FrameMode = "auto" | "phone" | "desktop" | "pane";

export type FramedDesign = {
  readonly phones: readonly PhoneSurface[];
  readonly desktops: readonly PhoneSurface[];
  readonly main: string | null;
};

export function framedDesign(content: string, mode: FrameMode, title: string): FramedDesign {
  if (mode === "pane") return { phones: [], desktops: [], main: content };
  if (mode === "phone") {
    // The phone screens in phones and everything else in the pane, as
    // before #264; a design with no phone screens goes whole into one phone.
    const split = splitPhoneSurfaces(content);
    return split.phones.length > 0
      ? { phones: split.phones, desktops: [], main: split.main }
      : { phones: [{ id: "whole", title, html: content }], desktops: [], main: null };
  }
  if (mode === "desktop") return { phones: [], desktops: [{ id: "whole", title, html: content }], main: null };
  const split = splitSurfaces(content);
  if (split.phones.length > 0 || split.desktops.length > 0) return split;
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
            <DesktopFrame key={`${frameKey}:${screen.id}`} title={screen.title}>
              <iframe
                ref={(element) => registerFrame?.(screen.id, element)}
                className="design-desktop-screen"
                title={`${screen.title}, in a ${DESKTOP_WINDOW.name.toLowerCase()}`}
                srcDoc={screen.html}
                sandbox=""
              />
            </DesktopFrame>
          ))}
        </div>
      ) : null}
      {framed.phones.length > 0 ? (
        <div className="phone-rack" aria-label="Phone screens">
          {framed.phones.map((phone) => (
            <IPhoneFrame key={`${frameKey}:${phone.id}`} title={phone.title}>
              <iframe
                ref={(element) => registerFrame?.(phone.id, element)}
                className="design-phone-screen"
                title={`${phone.title}, on an ${IPHONE_17_PRO.name}`}
                srcDoc={phone.html}
                sandbox=""
              />
            </IPhoneFrame>
          ))}
        </div>
      ) : null}
      {framed.main !== null ? (
        <iframe
          key={frameKey}
          ref={(element) => registerFrame?.("main", element)}
          className={paneClassName}
          title={title}
          srcDoc={framed.main}
          sandbox=""
          style={{ background: "#fff" }} // not-our-surface: a generated mockup is its own page
        />
      ) : null}
    </>
  );
}
