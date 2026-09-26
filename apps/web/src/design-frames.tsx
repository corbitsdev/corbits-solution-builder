/**
 * How a design is shown: each phone screen inside an iPhone, the rest in a
 * plain frame (#101). Shared by the stage-4 review, where feedback anchors
 * into every frame, and the artifact reader, where a past design is read.
 *
 * Every frame is `srcdoc` with an empty sandbox — a generated design is
 * untrusted, and gets no script and no origin — and none is mounted until
 * its document is here: a sandboxed frame handed a second document while
 * its first is still committing stays blank for good.
 */
import { IPhoneFrame, IPHONE_17_PRO } from "./iphone-frame.tsx";
import { splitPhoneSurfaces, type PhoneSurface } from "./phone-surfaces.ts";

/**
 * `auto` puts each screen the designer marked as a phone surface in an
 * iPhone and everything else in the pane; `phone` does that too, and a
 * design with no marked screen goes into one iPhone whole; `pane` is the
 * plain frame, marks or not.
 */
export type FrameMode = "auto" | "phone" | "pane";

/** The phones to draw and the document left for the pane, or null for none. */
export function framedDesign(
  content: string,
  mode: FrameMode,
  title: string,
): { phones: readonly PhoneSurface[]; main: string | null } {
  if (mode === "pane") return { phones: [], main: content };
  const split = splitPhoneSurfaces(content);
  if (split.phones.length > 0) return { phones: split.phones, main: split.main };
  if (mode === "phone") return { phones: [{ id: "whole", title, html: content }], main: null };
  return { phones: [], main: content };
}

export function FrameSelect({ value, onChange }: { value: FrameMode; onChange: (mode: FrameMode) => void }) {
  return (
    <select aria-label="Frame" value={value} onChange={(event) => onChange(event.target.value as FrameMode)}>
      <option value="auto">Frame: as designed</option>
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
  framed: ReturnType<typeof framedDesign>;
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
