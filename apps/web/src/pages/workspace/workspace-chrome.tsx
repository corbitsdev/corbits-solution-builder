/**
 * The workspace's quiet chrome: folded stage extras, the stage-1 evaluator
 * verdict, the product-guide dock, send-back, and the two waiting states. All
 * presentational — every prop is already resolved by the stage workspace
 * above them.
 */
import type { ReactNode, Ref } from "react";
import { Textarea } from "@corbits/react-ui";
import { Button, stageName } from "../../components.jsx";
import { Dictated } from "../../dictation.jsx";
import { RETURN_TO, SendBackPicker, defaultTarget } from "../send-back.jsx";
import { STAGE_GOAL } from "./gate.jsx";
import { clock, Elapsed, useElapsedMs } from "./elapsed.jsx";
import type { Guidance } from "./product-guide.js";
import type { evaluatorVerdict } from "./guidance.js";
import { CONV_CLASS, CONV_SCROLL_CLASS, PANES_CLASS, STAGE_PANE_CLASS } from "./pane-classes.ts";

type Choices = { readonly text: string; readonly choices: readonly string[] } | null;

/** Model, usage, guidance, verdict, send-back, and the product guide — one
 *  collapsed summary so they never stack as bands above the panes. */
export function GuidanceFold({ children }: { children: ReactNode }) {
  return (
    <details className="stage-chrome">
      <summary>Stage extras</summary>
      <div className="stage-chrome-body">{children}</div>
    </details>
  );
}

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

/** Sending the stage back is offered on hold-to-send, and again inside
 *  Guidance so a keyboard user still has a path — never as its own band. */
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
 *  this one, newest first, each named by what going back to it is for.
 *  Guidance still holds the full picker — a hold gesture is invisible to
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

/** Same centered, chat-first chrome as a stage with no draft yet, empty,
 *  for every phase before the first specialist reply: the workflow hasn't
 *  resolved a stage yet, or it has and the stage's specialist is still being
 *  deployed. One status line names which of those is true; the clock (CL-8874)
 *  is the only signal that anything is happening at all once it legitimately
 *  takes minutes (a host restart reconnecting every sidecar and catching the
 *  workflow run up). The restart-specific copy only applies to a project that
 *  already has history — never a brand-new one still on its first stage. */
export function OpeningScreen({
  status = "Starting the project…",
  resuming = false,
  since,
}: {
  status?: string;
  resuming?: boolean;
  /** When the opening sequence for this project began — one clock shared
   *  across every phase (workflow resolving, then the stage agent
   *  deploying), so it never visibly resets to 0:00 mid-open. */
  since?: string | null;
}) {
  const seconds = Math.floor(useElapsedMs(since) / 1_000);
  return (
    <div className="stage-view">
      <StagePanes
        className="chat-first"
        solo
        conversation={
          <div className="stage-conversation">
            <div className={CONV_SCROLL_CLASS}>
              <div className="think" role="status">
                <span className="who conv-who">{status}</span>
                <p className="elapsed">
                  <span className="elapsed-clock" role="timer" aria-live="off">
                    {clock(seconds)}
                  </span>{" "}
                  elapsed.
                  {resuming ? " A project reopened right after a restart can take several minutes to catch up." : ""}
                </p>
              </div>
            </div>
          </div>
        }
      >
        {null}
      </StagePanes>
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

/**
 * The stage workspace's two panes: the conversation on the left, the
 * artifact strip and the stage's surface on the right. Every stage shares
 * this shell — a stage's panel never replaces the conversation.
 */
export function StagePanes({
  conversation,
  strip = null,
  children,
  solo = false,
  conversationRef,
  className,
  paneTour,
  tour,
}: {
  conversation: ReactNode;
  strip?: ReactNode;
  children: ReactNode;
  /** Draft closed: conversation takes the width. */
  solo?: boolean;
  conversationRef?: Ref<HTMLElement>;
  className?: string;
  paneTour?: string;
  tour?: string;
}) {
  const panesClass = [PANES_CLASS, solo ? "is-solo" : null, className].filter(Boolean).join(" ");
  return (
    <div className={panesClass} {...(tour ? { "data-tour": tour } : {})}>
      <section ref={conversationRef} className={CONV_CLASS} aria-label="Conversation with the specialist">
        {conversation}
      </section>
      <article className={STAGE_PANE_CLASS} {...(paneTour ? { "data-tour": paneTour } : {})}>
        {strip ? <div className="artifact-strip">{strip}</div> : null}
        {children}
      </article>
    </div>
  );
}
