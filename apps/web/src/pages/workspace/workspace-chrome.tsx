/**
 * The workspace's quiet chrome: the stage guidance card, the stage-1
 * evaluator verdict, the product-guide dock, the send-back surface, and the
 * two waiting states. All presentational — every prop is already resolved by
 * the stage workspace above them.
 */
import type { ReactNode } from "react";
import { Textarea } from "@corbits/react-ui";
import { Button, Screen, stageName } from "../../components.jsx";
import { Dictated } from "../../dictation.jsx";
import { RETURN_TO, SendBackPicker, defaultTarget } from "../send-back.jsx";
import { STAGE_GOAL } from "./gate.jsx";
import { Elapsed } from "./elapsed.jsx";
import type { Guidance } from "./product-guide.js";
import type { evaluatorVerdict } from "./guidance.js";

type Choices = { readonly text: string; readonly choices: readonly string[] } | null;

/** The stage's current guidance — what the specialist is doing, and the
 *  recorded answer choices when the guidance carries a question. */
export function GuidanceCard({
  guidance,
  showChoices,
  sending,
  onChoice,
}: {
  guidance: { title: string; detail: string; readyNote?: string | null; question?: Choices };
  showChoices: boolean;
  sending: boolean;
  onChoice: (choice: string) => void;
}) {
  return (
    <div className="stage-guidance" aria-label={guidance.title}>
      <p className="stage-guidance-title">{guidance.title}</p>
      <p className="stage-guidance-detail">{guidance.detail}</p>
      {guidance.readyNote ? <p className="stage-guidance-ready">{guidance.readyNote}</p> : null}
      {guidance.question && guidance.question.choices.length > 0 && showChoices ? (
        <div className="button-row" aria-label="Recorded answer choices">
          {guidance.question.choices.map((choice) => (
            <Button key={choice} variant="ghost" disabled={sending} onClick={() => onChoice(choice)}>
              {choice}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Stage 1's advisory brief-evaluator verdict — never a gate. */
export function EvaluatorVerdict({ verdict }: { verdict: NonNullable<ReturnType<typeof evaluatorVerdict>> }) {
  return (
    <div className="stage-guidance stage-guidance-evaluator" aria-label="Brief evaluator verdict">
      <p className="stage-guidance-title">Brief evaluator (advisory): {verdict.ready ? "ready" : "not yet"}</p>
      {verdict.notes.length > 0 ? (
        <ul>
          {verdict.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The Product guide, folded: the deterministic checklist by default, the
 *  guide agent's own words once asked. */
export function ProductGuideDock({
  guide,
  asking,
  onAsk,
}: {
  guide: Guidance;
  asking: boolean;
  onAsk: () => void;
}) {
  return (
    <details className="approvals-record product-guide">
      <summary>{guide.origin === "guide" ? "Guide" : "Checklist"} · where this project stands</summary>
      <div className="product-guide-body">
        <p className="product-guide-source">
          {guide.origin === "guide"
            ? "The guide's own words — advisory only, never a verdict."
            : "The checklist, computed from what is already recorded."}
        </p>
        <p>{guide.summary}</p>
        {guide.missing.length > 0 ? (
          <ul>
            {guide.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        <p className="product-guide-recommended">Recommended next step: {guide.recommended}</p>
        <Button variant="ghost" loading={asking} onClick={onAsk}>
          Ask the guide
        </Button>
      </div>
    </details>
  );
}

/** Sending the stage back is offered wherever the person is working, folded
 *  to a line so it never competes with the review itself. */
export function SendBackDock({
  stage,
  target,
  reason,
  sendingBack,
  onTargetChange,
  onReasonChange,
  onSendBack,
}: {
  stage: number;
  target: number | null;
  reason: string;
  sendingBack: boolean;
  onTargetChange: (target: number | null) => void;
  onReasonChange: (reason: string) => void;
  onSendBack: (target: number) => void;
}) {
  const chosen = target ?? defaultTarget(stage);
  return (
    <details className="approvals-record send-back">
      <summary>Missed something earlier? Send this stage back…</summary>
      <div className="send-back-body">
        <SendBackPicker id="workspace-send-back-target" stage={stage} target={chosen} onChange={onTargetChange} />
        <div className="field">
          <label htmlFor="workspace-send-back-reason">What was missed, or what has to change</label>
          <Dictated value={reason} onValueChange={onReasonChange} align="start">
            <Textarea
              id="workspace-send-back-reason"
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="Recorded with the send-back, and put in the box at the stage you return to, for the specialist."
            />
          </Dictated>
        </div>
        <div className="action-row">
          <Button loading={sendingBack} onClick={() => onSendBack(chosen)}>
            Send back to {stageName(chosen)}
          </Button>
        </div>
      </div>
    </details>
  );
}

/** The send-back picker hold raises over the composer: every stage up to
 *  this one, newest first, each named by what going back to it is for. The
 *  dock below stays the visible path — a hold gesture is invisible to
 *  keyboard and discovery both. */
export function SendBackPopover({
  stage,
  open,
  onPick,
  onDismiss,
}: {
  stage: number;
  open: boolean;
  onPick: (target: number) => void;
  onDismiss: () => void;
}) {
  if (!open || stage < 2) return null;
  const targets = Array.from({ length: stage }, (_, index) => stage - index);
  return (
    <>
      <button type="button" className="sbpick-backdrop" aria-label="Dismiss" onClick={onDismiss} />
      <div className="sbpick" role="dialog" aria-label="Send this stage back">
        <p className="sbpick-head">Send back to…</p>
        {targets.map((target) => (
          <button key={target} type="button" className="sbpick-row" onClick={() => onPick(target)}>
            <span className="sbpick-name">
              Stage {target} · {stageName(target)}
            </span>
            <span className="sbpick-why">
              {target === stage ? "this stage again" : RETURN_TO[target] ? `to ${RETURN_TO[target]}` : ""}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The neutral "opening" screen — shown while the workflow view is still
 *  unresolved so the person never sees a stage briefly flash to something
 *  the workflow never said (CL-8721). */
export function OpeningScreen() {
  return (
    <div className="stage-view">
      <Screen title="Opening the project…" description="Finding the project and reading where its workflow stands." tight>
        <section aria-label="Opening progress">
          <p className="inline-note">Finding the project → reading its stage → preparing the conversation.</p>
          <div
            role="progressbar"
            aria-label="Opening the project"
            aria-valuetext="Reading its stage"
            style={{ height: 6, borderRadius: 4, overflow: "hidden", background: "var(--wb-border)", margin: "8px 0 16px" }}
          >
            <div style={{ height: "100%", width: "50%", borderRadius: 4, background: "var(--wb-primary)" }} />
          </div>
        </section>
        <div aria-hidden="true">
          <div
            style={{
              border: "1px solid var(--wb-border)",
              borderRadius: 8,
              padding: "12px 14px",
              marginBottom: 8,
            }}
          >
            <div style={{ height: 11, borderRadius: 6, width: "38%", background: "var(--wb-border)", margin: "6px 0" }} />
            <div style={{ height: 11, borderRadius: 6, width: "92%", background: "var(--wb-border)", margin: "6px 0" }} />
            <div style={{ height: 11, borderRadius: 6, width: "78%", background: "var(--wb-border)", margin: "6px 0" }} />
          </div>
          <p className="thinking">Getting the conversation ready…</p>
        </div>
        <p className="inline-note">What comes next: the conversation opens below.</p>
      </Screen>
    </div>
  );
}

/** A document stage with no draft yet: the interview-progress bar, the
 *  waiting line, tips, and the waiting actions (send again / stop / change
 *  model). The conversation itself renders beside it. */
export function WaitingSection({
  stage,
  progress,
  hasMessages,
  lastPersonAt,
  tip,
  choices,
  sending,
  awaitingActions,
  onChoice,
  onSendAgain,
  onStop,
  onOpenSettings,
  children,
}: {
  stage: number;
  progress: { ordinal: number; total: number | null } | null;
  hasMessages: boolean;
  lastPersonAt: string | null;
  tip: string;
  choices: Choices;
  sending: boolean;
  awaitingActions: { canSendAgain: boolean; hasPending: boolean };
  onChoice: (choice: string) => void;
  onSendAgain: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
}) {
  return (
    <section aria-label="What is happening now" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        role="progressbar"
        aria-label={`Stage ${stage} of 9 · ${stageName(stage)}`}
        aria-valuetext={
          progress && progress.total !== null
            ? `Question ${progress.ordinal} of ${progress.total}`
            : progress
              ? `Question ${progress.ordinal} so far`
              : "Waiting for the specialist's reply"
        }
        style={{ height: 6, borderRadius: 4, overflow: "hidden", background: "var(--wb-border)", margin: "0 0 12px" }}
      >
        <div
          style={{
            height: "100%",
            borderRadius: 4,
            background: "var(--wb-primary)",
            width:
              progress && progress.total !== null
                ? `${Math.min(100, Math.round((progress.ordinal / progress.total) * 100))}%`
                : "38%",
          }}
        />
      </div>
      <p className="inline-note">
        Stage {stage} of 9 · {stageName(stage)} — {STAGE_GOAL[stage]}
      </p>
      <div className="inline-note" role="status">
        {hasMessages ? (
          <span className="thinking">Your message is recorded; no specialist reply is visible yet.</span>
        ) : (
          "No message from you is recorded yet."
        )}{" "}
        {hasMessages ? <Elapsed since={lastPersonAt} /> : null}
      </div>
      <p className="inline-note">{tip}</p>
      {choices && choices.choices.length > 0 ? (
        <div className="button-row" aria-label="Recorded answer choices">
          {choices.choices.map((choice) => (
            <Button key={choice} variant="ghost" disabled={sending} onClick={() => onChoice(choice)}>
              {choice}
            </Button>
          ))}
        </div>
      ) : null}
      {(awaitingActions.canSendAgain || awaitingActions.hasPending) && hasMessages ? (
        <div className="button-row" aria-label="Waiting actions">
          {awaitingActions.canSendAgain ? (
            <Button variant="outline" onClick={onSendAgain}>
              Send again
            </Button>
          ) : null}
          {awaitingActions.hasPending ? (
            <Button variant="ghost" onClick={onStop}>
              Stop
            </Button>
          ) : null}
          {awaitingActions.canSendAgain ? (
            <Button variant="ghost" onClick={onOpenSettings}>
              Open Settings to pick a different model
            </Button>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
