import { useBusyIndicator } from "../../use-busy.ts";
import { useSecondsSince } from "../../zen-garden.tsx";
import { useZenGarden } from "../../zen-garden-setting.ts";
import { clock } from "./elapsed.tsx";
import { WaitingTips } from "./waiting-tips.tsx";

/** What the busy label says after the specialist's name, so the name is
 *  said once: "is drawing the design", or the label itself set apart when
 *  it does not start with the name ("Opening the conversation"). */
function doingAfter(who: string, label: string | null): string {
  if (label === null) return " is getting ready";
  if (label.startsWith(`${who} `)) return label.slice(who.length);
  return ` · ${label}`;
}

/** Before the specialist's first reply: who is working, centred, and that
 *  the work does not need this screen. With the zen garden on, its strip
 *  already says what is being done and for how long, so this names only
 *  the specialist and holds the tip beneath; with it off, this carries the
 *  activity and the clock, and the tip sits at the foot of the window. */
export function OpeningWait({ who }: { who: string }) {
  const garden = useZenGarden() === "on";
  const { visible, since, label } = useBusyIndicator();
  const seconds = useSecondsSince(visible && !garden ? since : null);
  // The foot-of-window tip stays a sibling: the thread animates its last
  // row with a transform, which would pin a fixed child to that row instead.
  return (
    <>
      <div className="opening-wait">
        <div className="opening-wait-body" role="status" aria-live="polite">
          <p className="opening-wait-title">
            {who}
            {garden ? null : <span className="opening-wait-doing">{doingAfter(who, visible ? label : null)}</span>}
          </p>
          {!garden && visible ? (
            <p className="opening-wait-clock" role="timer" aria-live="off">
              {clock(seconds)}
            </p>
          ) : null}
          <p className="opening-wait-lead">The work carries on if you leave this screen. It will be here when you come back.</p>
        </div>
        {garden ? <WaitingTips inline /> : null}
      </div>
      {garden ? null : <WaitingTips />}
    </>
  );
}
