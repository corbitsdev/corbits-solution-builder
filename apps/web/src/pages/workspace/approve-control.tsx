import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Button } from "../../components.jsx";
import type { StageEvaluator } from "./use-advisory.ts";
import { EvaluatorStance } from "./workspace-chrome.tsx";

/**
 * Every stage's approval, one row under the composer: the evaluator's stance
 * and anything approving waits on to the left, the ask and its button to the
 * right, then a confirm in place.
 */
export function ApproveControl({
  label = "Approve",
  evaluator = null,
  notesError = null,
  waiting = null,
  busy = false,
  doing,
  onApprove,
}: {
  label?: "Approve" | "Send for approval";
  /** Null on a stage no evaluator reads. */
  evaluator?: StageEvaluator | null;
  notesError?: string | null;
  /** A stage's own gate, said in words; the button waits while it is set. */
  waiting?: ReactNode;
  busy?: boolean;
  doing?: string;
  onApprove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const ready = evaluator?.status === "verdict" && evaluator.verdict.ready;
  return (
    <div className="stage-action composer-approve">
      <span className="composer-approve-lead">
        {evaluator ? <EvaluatorStance evaluator={evaluator} notesError={notesError} /> : null}
        {waiting ? <span className="composer-note">{waiting}</span> : null}
      </span>
      {confirming ? (
        <span className="approve-confirm" role="group" aria-label="Confirm">
          <span>{evaluator && !ready ? "Continue anyway?" : label === "Approve" ? "Approve this and move on?" : "Send this for approval?"}</span>
          <Button
            variant="ghost"
            loading={busy}
            onClick={() => {
              setConfirming(false);
              onApprove();
            }}
          >
            Yes
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            No
          </Button>
        </span>
      ) : (
        <span data-tour="submit" data-ready={ready ? "true" : undefined} className={ready ? "is-ready approve" : "approve"}>
          <span>{label === "Approve" ? "Happy with it?" : "Nothing more to say?"}</span>
          <Button
            variant="ghost"
            loading={busy}
            disabled={Boolean(waiting)}
            {...(doing ? { doing } : {})}
            onClick={() => setConfirming(true)}
          >
            <Check aria-hidden="true" />
            {label}
          </Button>
        </span>
      )}
    </div>
  );
}
