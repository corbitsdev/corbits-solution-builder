import { AnimatedNumber } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import type { StageTurn } from "../../client.js";
import { stageName } from "../../components.jsx";
import { Elapsed } from "./elapsed.jsx";
import { STAGE_GOAL } from "./gate.jsx";

/** Nothing back from the specialist for this long counts as a stall worth naming. */
export const STALL_AFTER_MS = 25_000;

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
 * The stage before it has a draft: the specialist is reading and writing, and
 * this is the whole screen while it does. A form to fill in here asked for
 * something the approved work already says; a table of past decisions below it
 * answered a question nobody was asking.
 */
export function Preparing({
  stage,
  said,
  busy,
  since = null,
}: {
  stage: number;
  said: StageTurn[];
  busy: boolean;
  /** When the host says the draft step began, where it says so. */
  since?: string | null;
}) {
  const tips = STAGE_TIPS[stage] ?? STAGE_TIPS[1]!;
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTip((at) => (at + 1) % tips.length), 7_000);
    return () => clearInterval(timer);
  }, [tips.length]);

  // Nothing to name a stall against until the wait actually starts.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!busy) return;
    const started = since ? Date.parse(since) : Number.NaN;
    const remaining = STALL_AFTER_MS - (Date.now() - (Number.isNaN(started) ? Date.now() : started));
    const timer = setTimeout(() => setStalled(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [busy, since]);

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
        {/* What the running process is doing, boxed and labelled so it reads
            as status and not as another tip. The tips stay outside it. */}
        <div className="preparing-status" role="status" aria-label="What is happening now">
          <p className="preparing-status-label">Working</p>
          {!busy ? (
            <span className="thinking">Starting</span>
          ) : (
            <span className="thinking">
              {stage === 4
                ? "The designer is drawing the first mockup"
                : said.length > 0
                  ? "Reading what you wrote"
                  : "Reading the approved work from earlier stages"}
            </span>
          )}
          {busy ? <Elapsed stage={stage} since={since} /> : null}
          {stalled ? (
            <p className="preparing-stall">
              Still waiting on the specialist: nothing has come back for a while. If this keeps
              happening, try another provider in Settings.
            </p>
          ) : null}
        </div>
        <p key={tip} className="preparing-tip">
          {tips[tip]}
        </p>
      </div>
    </section>
  );
}
