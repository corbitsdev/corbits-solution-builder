/**
 * The workspace's quiet chrome: folded stage extras, the stage evaluator
 * verdict, the product-guide dock, send-back, and the two waiting states. All
 * presentational — every prop is already resolved by the stage workspace
 * above them.
 */
import { useId, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { Button, stageName } from "../../components.jsx";
import { InlineMarkdown, Markdown } from "../../markdown.jsx";
import { RETURN_TO } from "../send-back.jsx";
import { STAGE_GOAL } from "./gate.jsx";
import type { StageEvaluator } from "./use-advisory.ts";
import { CONV_CLASS, CONV_SCROLL_CLASS, PANES_CLASS, STAGE_PANE_CLASS } from "./pane-classes.ts";
import { usePanesWidth } from "./use-panes-width.ts";
import { WaitingTips } from "./waiting-tips.tsx";
import { BusyLine } from "../../zen-garden.tsx";

/**
 * A stage evaluator's advisory verdict, as one line in the approval
 * bar (#157): a stance beside the approve button, with the evaluator's notes
 * opening beneath it on a click and closing on a second click or Escape.
 * Never a gate: the approve button's enablement is unchanged. A full
 * verdict inline above the composer pushed the conversation out of
 * view, and the gate repeated its notes a second time.
 */
export function EvaluatorStance({ evaluator, notesError = null }: { evaluator: StageEvaluator; notesError?: string | null }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (evaluator.status === "idle") return null;
  const judged =
    evaluator.status === "checking"
      ? { label: "Evaluator reading…", tone: "checking", notes: [] as readonly string[] }
      : evaluator.status === "unavailable"
        ? { label: "Evaluator unavailable", tone: "unavailable", notes: [evaluator.reason] }
        : evaluator.verdict.ready
          ? { label: "Approved by evaluator", tone: "ready", notes: evaluator.verdict.notes }
          : { label: "Not approved by evaluator", tone: "not-ready", notes: evaluator.verdict.notes };
  const stance = notesError
    ? { ...judged, notes: [...judged.notes, `These notes could not be sent to the specialist: ${notesError}`] }
    : judged;
  const hasNotes = stance.notes.length > 0;
  return (
    <span className="evaluator-stance" data-tone={stance.tone} data-open={open || undefined} aria-live="polite">
      <button
        type="button"
        className="evaluator-stance-trigger"
        aria-label="Evaluator verdict"
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
        <div id={id} className="evaluator-notes">
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

/** The send-back picker hold raises over the composer: every stage up to
 *  this one, newest first, each named by what going back to it is for.
 *  Guidance still holds the full picker — a hold gesture is invisible to
 *  keyboard and discovery both. */
export function SendBackPopover({
  stage,
  skipped,
  open,
  onPick,
  onDismiss,
}: {
  stage: number;
  /** Stages the project's surface made not applicable: nothing to go back to. */
  skipped: readonly number[];
  open: boolean;
  onPick: (target: number) => void;
  onDismiss: () => void;
}) {
  if (!open || stage < 2) return null;
  const targets = Array.from({ length: stage }, (_, index) => stage - index).filter((target) => !skipped.includes(target));
  return (
    <>
      <button type="button" className="sbpick-backdrop" aria-label="Dismiss" onClick={onDismiss} />
      <div className="sbpick" role="dialog" aria-label="Send this stage back">
        <p className="sbpick-head">Send back to…</p>
        {targets.map((target) => (
          <button key={target} type="button" className="sbpick-row" onClick={() => onPick(target)}>
            <span className="sbpick-name">
              {stageName(target)}
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
