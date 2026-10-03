/**
 * The workspace's quiet chrome: folded stage extras, the stage-1 evaluator
 * verdict, the product-guide dock, send-back, and the two waiting states. All
 * presentational — every prop is already resolved by the stage workspace
 * above them.
 */
import { useEffect, useId, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { Textarea } from "@corbits/react-ui";
import { Button, stageName } from "../../components.jsx";
import { Dictated } from "../../dictation.jsx";
import { InlineMarkdown, Markdown } from "../../markdown.jsx";
import { RETURN_TO, SendBackPicker, defaultTarget } from "../send-back.jsx";
import { STAGE_GOAL } from "./gate.jsx";
import { Elapsed } from "./elapsed.jsx";
import type { StageEvaluator } from "./use-advisory.ts";
import { CONV_CLASS, CONV_SCROLL_CLASS, PANES_CLASS, STAGE_PANE_CLASS } from "./pane-classes.ts";
import { usePanesWidth } from "./use-panes-width.ts";
import { WaitingTips } from "./waiting-tips.tsx";
import { BusyLine } from "../../zen-garden.tsx";

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

/**
 * Stage 1's advisory brief-evaluator verdict, as one line in the approval
 * bar (#157): a stance beside the approve button, with the evaluator's notes
 * in a popover that opens on hover, on focus, or with a click and closes on
 * Escape. Never a gate: the approve button's enablement is unchanged. A
 * full verdict inline above the composer pushed the conversation out of
 * view, and the gate repeated its notes a second time.
 */
export function EvaluatorStance({ evaluator }: { evaluator: StageEvaluator }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (evaluator.status === "idle") return null;
  const stance =
    evaluator.status === "checking"
      ? { label: "Evaluator reading…", tone: "checking", notes: [] as readonly string[] }
      : evaluator.status === "unavailable"
        ? { label: "Evaluator unavailable", tone: "unavailable", notes: [evaluator.reason] }
        : evaluator.verdict.ready
          ? { label: "Approved by evaluator", tone: "ready", notes: evaluator.verdict.notes }
          : { label: "Not approved by evaluator", tone: "not-ready", notes: evaluator.verdict.notes };
  const hasNotes = stance.notes.length > 0;
  return (
    <span className="evaluator-stance" data-tone={stance.tone} data-open={open || undefined} aria-live="polite">
      <button
        type="button"
        className="evaluator-stance-trigger"
        aria-label="Brief evaluator verdict"
        aria-expanded={hasNotes ? open : undefined}
        aria-controls={hasNotes ? id : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {stance.label}
      </button>
      {hasNotes ? (
        <div id={id} role="tooltip" className="evaluator-notes">
          <ul>
            {stance.notes.map((note, index) => (
              <li key={index}>
                <InlineMarkdown source={note} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
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

/**
 * The reader's way to send the project back to the stage whose document is
 * open (#248): a card beside the button that names the one target the
 * button promised, takes an optional reason, and sends on confirm. Not the
 * composer's picker, which is anchored to the composer and lists every
 * stage — from a past stage's document, that read as nothing happening.
 */
export function SendBackConfirm({
  target,
  busy,
  onConfirm,
  onCancel,
}: {
  target: number;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="sbconfirm" role="dialog" aria-label={`Send back to ${stageName(target)}`}>
      <p className="sbconfirm-head">
        Send the project back to stage {target} · {stageName(target)}
        {RETURN_TO[target] ? `, to ${RETURN_TO[target]}` : ""}. Every review from there on is marked stale; nothing is deleted.
      </p>
      <textarea
        className="sbconfirm-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="What should change, optional"
        aria-label="Why it is being sent back, optional"
        rows={3}
        autoFocus
      />
      <div className="sbconfirm-actions">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} doing={`Sending back to ${stageName(target)}`} onClick={() => onConfirm(reason)}>
          Send back to {stageName(target)}
        </Button>
      </div>
    </div>
  );
}

function capitalize(word: string): string {
  return word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/** Same centered, chat-first chrome as a stage with no draft yet, for every
 *  phase before the stage's specialist can take a message: a project
 *  opening, or the next stage's specialist being set up after an approval.
 *  No composer, since nothing could be sent yet; it arrives with the
 *  conversation once the specialist is live. What shows is only what is
 *  already on hand: the person's opening statement as their own chat bubble
 *  (once a brand-new project's read resolves), a quiet status line in the
 *  specialist's slot, and a rotating tip in the space below. A project
 *  reopening (`resuming`) shows its current stage's own latest persisted
 *  draft (`draft`, read off the artifact fold the same way the document
 *  pane does) beside a "Reconnecting…" status line while the mail thread
 *  catches up; both reads are real, never simulated, so either renders
 *  blank rather than a fake state until its read resolves. */
export function OpeningScreen({
  resuming = false,
  who,
  opening,
  draft,
}: {
  resuming?: boolean;
  /** The specialist's name, lowercased, for the reconnect line — e.g.
   *  "brainstormer". */
  who: string;
  /** A brand-new project's own opening statement, once its read resolves. */
  opening?: string | null | undefined;
  /** The current stage's latest persisted draft, already on `detail.nodes`
   *  — null while none exists yet (a brand-new project) or none is selected. */
  draft?: { title: string; version: number; content: string } | null | undefined;
}) {
  const specialist = capitalize(who);
  return (
    <div className="stage-view">
      <StagePanes
        className="chat-first"
        solo
        conversation={
          <div className="stage-conversation">
            <div className={CONV_SCROLL_CLASS}>
              {!resuming && opening ? (
                <div className="msg you">
                  <span className="who conv-who">You</span>
                  <div className="bubble">
                    <Markdown source={opening} />
                  </div>
                </div>
              ) : null}
              <div className="think" role="status">
                <span className="who conv-who">{specialist}</span>
                <span className="thinking">
                  {resuming ? `Reconnecting to the ${specialist}…` : `The ${specialist} is getting ready…`}
                </span>
              </div>
              <BusyLine />
              <WaitingTips />
            </div>
          </div>
        }
      >
        {draft ? (
          <div className="stage-inner">
            <div className="doc">
              <div className="docmeta">
                <span>
                  {draft.title} · v{draft.version}
                </span>
              </div>
              {draft.content ? <Markdown source={draft.content} /> : <p className="inline-note">Loading…</p>}
            </div>
          </div>
        ) : null}
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
 * `value`, one render late, so a layout that switches on it switches inside
 * a view transition: the first draft moves the centered conversation, its
 * composer with it, over to the left pane while the document arrives,
 * rather than the page jumping. At once where the API is missing or motion
 * is reduced.
 */
export function useViewTransitioned<T>(value: T): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (Object.is(shown, value)) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof document.startViewTransition !== "function") {
      setShown(value);
      return;
    }
    document.startViewTransition(() => flushSync(() => setShown(value)));
  }, [value, shown]);
  return shown;
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
  busy = false,
}: {
  conversation: ReactNode;
  strip?: ReactNode;
  children: ReactNode;
  /** Draft closed: conversation takes the width. */
  solo?: boolean;
  /** A specialist turn is in flight (#87), until the reply lands. */
  busy?: boolean;
  conversationRef?: Ref<HTMLElement>;
  className?: string;
  paneTour?: string;
  tour?: string;
}) {
  const split = !solo && className !== "chat-first";
  const panesWidth = usePanesWidth();
  const panesClass = [PANES_CLASS, solo ? "is-solo" : null, className].filter(Boolean).join(" ");
  return (
    <div
      className={panesClass}
      style={split ? (panesWidth.style as CSSProperties) : undefined}
      {...(tour ? { "data-tour": tour } : {})}
    >
      <section
        ref={conversationRef}
        className={CONV_CLASS}
        aria-label="Conversation with the specialist"
        data-inference-pending={busy ? "" : undefined}
      >
        {conversation}
      </section>
      {split ? (
        <div
          ref={panesWidth.separatorRef}
          className="panes-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the chat and document panes"
          aria-valuenow={panesWidth.valueNow}
          aria-valuemin={panesWidth.min}
          aria-valuemax={panesWidth.max}
          tabIndex={0}
          onPointerDown={panesWidth.onPointerDown}
          onPointerMove={panesWidth.onPointerMove}
          onPointerUp={panesWidth.onPointerUp}
          onKeyDown={panesWidth.onKeyDown}
          onDoubleClick={panesWidth.onDoubleClick}
        />
      ) : null}
      <article className={STAGE_PANE_CLASS} {...(paneTour ? { "data-tour": paneTour } : {})}>
        {strip ? <div className="artifact-strip">{strip}</div> : null}
        {children}
      </article>
    </div>
  );
}
