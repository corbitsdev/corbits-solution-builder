import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Button } from "../../components.jsx";
import type { StageEvaluator } from "./use-advisory.ts";
import { EvaluatorStance } from "./workspace-chrome.tsx";

/**
 * Every stage's approval, one row under the composer: the evaluator's stance
 * and anything approving waits on to the left, Continue to the right. One
 * click approves; an evaluator that has not approved makes it "Continue
 * anyway".
 */
export function ApproveControl({
  evaluator = null,
  notesError = null,
  waiting = null,
  busy = false,
  doing,
  onApprove,
}: {
  /** Null on a stage no evaluator reads. */
  evaluator?: StageEvaluator | null;
  notesError?: string | null;
  /** A stage's own gate, said in words; the button waits while it is set. */
  waiting?: ReactNode;
  busy?: boolean;
  doing?: string;
  onApprove: () => void;
}) {
  const ready = !evaluator || (evaluator.status === "verdict" && evaluator.verdict.ready);
  return (
    <div className="stage-action composer-approve">
      <span className="composer-approve-lead">
        {evaluator ? <EvaluatorStance evaluator={evaluator} notesError={notesError} /> : null}
        {waiting ? <span className="composer-note">{waiting}</span> : null}
      </span>
      <span data-tour="submit" data-ready={ready ? "true" : undefined} className={ready ? "is-ready approve" : "approve"}>
        {ready ? <span>Happy with this?</span> : null}
        <Button variant="ghost" loading={busy} disabled={Boolean(waiting)} {...(doing ? { doing } : {})} onClick={onApprove}>
          <Check aria-hidden="true" />
          {ready ? "Continue" : "Continue anyway"}
        </Button>
      </span>
    </div>
  );
}
