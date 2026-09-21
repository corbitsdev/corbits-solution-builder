import { useEffect, useState } from "react";
import { AnimatedNumber } from "@corbits/react-ui";
import { Button, stageName } from "../../components.jsx";
import { Elapsed, useElapsedMs } from "./elapsed.jsx";
import { STAGE_GOAL } from "./gate.jsx";

/** Nothing back from the specialist for this long is a stall worth naming. */
export const STALL_AFTER_MS = 3 * 60_000;
/** This long with no visible reply is worth saying plainly: a weak model can
 * return an empty reply, and nothing else tells the person that happened. */
export const SILENT_AFTER_MS = 10 * 60_000;

/** Same shape as main's stage tips (CL-8726 parity): what the wait is worth
 * knowing while a specialist reads and writes. */
export const STAGE_TIPS: Record<number, string[]> = {
  1: [
    "The specialist interviews the problem, not a solution. Answer with what hurts, not what to build.",
    "One real example beats a general description. Name the last time this cost you an afternoon.",
    "Rough answers are fine. Every answer becomes a new version of the brief, and you approve before anything is built.",
  ],
  2: [
    "This stage bounds the shape: platforms, privacy, integrations, installation and what is out of scope.",
    "Non-goals are as valuable as goals. Saying what this will not do keeps the build honest.",
    "If a constraint feels obvious, say it anyway. The specialist only knows what the approved brief says.",
  ],
  3: [
    "At most two approaches, side by side on the same criteria. You choose one; the specialist only recommends.",
    "The comparison is against the success criteria from stage 1, so weak criteria make a weak choice.",
    "Not happy with either? Say what should be different and both are redrafted. That is a normal outcome.",
  ],
  4: [
    "Design works out surfaces, flows and states, and the criteria the build is measured against.",
    "Every state matters: empty, loading, error and success. A flow that only shows the happy path hides the work.",
    "Feedback on a screen can quote it directly. Select text in the draft to attach it to what you say.",
  ],
  5: [
    "Each stakeholder gets their own package answering one question: is this worth pursuing?",
    "A package is written for its reader. A founder and an engineer should not be handed the same page.",
    "Stage 5 needs a quorum. The project moves on when enough stakeholders have decided.",
  ],
  6: [
    "The plan is what the code builder executes, so vagueness here becomes vagueness in the build.",
    "Four principals review the plan separately. Their findings are not merged, so you can see where they disagree.",
    "A plan step you cannot picture being done is a step the builder cannot do either.",
  ],
  7: [
    "The estimate is firm, not a range. Approving it approves the spend.",
    "Cost follows the plan. If the number surprises you, the place to push back is stage 6.",
    "Nothing is built until this is approved.",
  ],
};

/**
 * The stage before the thread contains a substantial draft. Mail exposes the
 * submitted turn and eventual reply, not intermediate agent activity, so this
 * view reports only that evidence — plus what the wait itself is worth
 * knowing, and what to do if it has gone on too long.
 */
export function Preparing({
  stage,
  busy,
  since = null,
  waiting = false,
  lastMessage = null,
  onSendAgain,
  onOpenSettings,
}: {
  stage: number;
  busy: boolean;
  /** When the host says the person's last message was recorded. */
  since?: string | null;
  /** No visible specialist reply is recorded after that message yet. */
  waiting?: boolean;
  /** The person's last recorded message, resent by "Send again". */
  lastMessage?: string | null;
  onSendAgain?: () => void;
  onOpenSettings?: () => void;
}) {
  const tips = STAGE_TIPS[stage] ?? STAGE_TIPS[1]!;
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTip((at) => (at + 1) % tips.length), 7_000);
    return () => clearInterval(timer);
  }, [tips.length]);

  const elapsedMs = useElapsedMs(since);
  const stalled = waiting && elapsedMs >= STALL_AFTER_MS;
  const silent = waiting && elapsedMs >= SILENT_AFTER_MS;

  return (
    <section className="preparing" aria-live="polite">
      <header className="preparing-head">
        <p className="preparing-kicker">
          Stage <AnimatedNumber value={stage} /> of 9
        </p>
        <h2>{stageName(stage)}</h2>
        <p className="preparing-goal">{STAGE_GOAL[stage]}</p>
      </header>

      <div className="preparing-activity">
        <div className="preparing-status" role="status" aria-label="What is happening now">
          <p className="preparing-status-label">Thread status</p>
          {!busy ? (
            <span className="thinking">No message from you is recorded yet.</span>
          ) : (
            <span className="thinking">Your message is recorded; no specialist reply is visible yet.</span>
          )}
          {busy ? <Elapsed since={since} /> : null}
          {silent ? (
            <div className="preparing-stall preparing-silent">
              <p>
                Ten minutes with nothing usable back: the specialist may have returned nothing at all. That can
                happen with a weaker model.
              </p>
              <div className="button-row">
                {onSendAgain && lastMessage ? (
                  <Button variant="outline" onClick={onSendAgain}>
                    Send again
                  </Button>
                ) : null}
                {onOpenSettings ? (
                  <Button variant="ghost" onClick={onOpenSettings}>
                    Open Settings to pick a different model
                  </Button>
                ) : null}
              </div>
            </div>
          ) : stalled ? (
            <div className="preparing-stall">
              <p>Still waiting on the specialist: nothing has come back for a while.</p>
              {onSendAgain && lastMessage ? (
                <div className="button-row">
                  <Button variant="outline" onClick={onSendAgain}>
                    Send again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <p key={tip} className="preparing-tip">
          {tips[tip]}
        </p>
      </div>
    </section>
  );
}
