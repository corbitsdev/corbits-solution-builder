import { AnimatedNumber } from "@corbits/react-ui";
import { stageName } from "../../components.jsx";
import { Elapsed } from "./elapsed.jsx";
import { STAGE_GOAL } from "./gate.jsx";

/**
 * The stage before the thread contains a substantial draft. Mail exposes the
 * submitted turn and eventual reply, not intermediate agent activity, so this
 * view reports only that evidence.
 */
export function Preparing({
  stage,
  busy,
  since = null,
}: {
  stage: number;
  busy: boolean;
  /** When the host says the draft step began, where it says so. */
  since?: string | null;
}) {
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
        </div>
        <p className="preparing-tip">The next action is shown above from the recorded thread.</p>
      </div>
    </section>
  );
}
