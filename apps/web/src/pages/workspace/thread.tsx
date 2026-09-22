import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChatInput, ChatThread, type ChatMessage as UiChatMessage } from "@corbits/react-ui";
import { Markdown } from "../../markdown.jsx";
import { Dictated } from "../../dictation.jsx";
import type { ChatMessage } from "../../stage-mail.ts";
import { choicesIn } from "./choices.js";
import { eventMessages, type StageEvent } from "./stage-events.ts";
import { COMPOSER_BOX_CLASS, CONV_SCROLL_CLASS } from "./pane-classes.ts";

/** A stage-mail turn, rendered as a `@corbits/react-ui` chat message: the
 *  person's turns on the right, the specialist's on the left. */
function toUiMessages(messages: readonly ChatMessage[]): UiChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.author === "me" ? "user" : "agent",
    parts: [{ type: "text", text: message.body }],
    createdAt: message.at,
  }));
}

/**
 * The stage's conversation with its specialist: a mail thread rendered as
 * chat. The composer is always visible — sending is always possible, whether
 * or not a draft exists yet, since the specialist is a mail agent that just
 * answers whatever it is sent.
 *
 * A turn the person stopped before it was answered stays in the transcript,
 * dimmed, with no reply of its own. A turn still awaiting its reply shows
 * main's working line in the transcript while the composer keeps its existing
 * working-and-Stop behavior.
 */
export function StageConversation({
  stage,
  messages,
  value,
  onValueChange,
  onSend,
  working = false,
  disabled = false,
  placeholder = "Say what should change…",
  withdrawnIds = EMPTY_WITHDRAWN,
  pending = false,
  onStop,
  onSendHold,
  popover = null,
  events = EMPTY_EVENTS,
  rows = null,
  who = "Specialist",
  onAttach,
}: {
  stage: number;
  messages: readonly ChatMessage[];
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  /** The specialist has not replied to the last turn yet. */
  working?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Ids of person turns Stop withdrew, rendered dimmed with no reply. */
  withdrawnIds?: ReadonlySet<string>;
  /** The last turn is a person message nothing has answered yet. */
  pending?: boolean;
  /** Restores that turn to the composer and records the withdrawal. */
  onStop?: () => void;
  /** Holding send raises the heavier alternative to a plain send. */
  onSendHold?: () => void;
  /** Floated over the composer — the send-back picker hold opens. */
  popover?: ReactNode;
  /** The stage's event record — decisions, versions, aborted turns — folded
   *  into the transcript as quiet lines. */
  events?: readonly StageEvent[];
  /** Quiet rows above the box: the open gate, a pending capability grant. */
  rows?: ReactNode;
  /** The specialist's name on its turns. */
  who?: string;
  /** The paperclip: files join the project as material for the next draft. */
  onAttach?: (files: FileList) => void;
}) {
  const uiMessages = useMemo(() => {
    const list = toUiMessages(messages);
    // A turn in flight has no row of its own yet, so the transcript would sit
    // unchanged after the person hits send. This is the one message the thread
    // shows that the host has not recorded.
    if (pending) {
      list.push({
        id: "pending",
        role: "agent",
        parts: [{ type: "text", text: "Writing…" }],
        createdAt: messages.at(-1)?.at ?? new Date().toISOString(),
      });
    }
    return eventMessages(list, events);
  }, [messages, pending, events]);
  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  return (
    <div className="stage-conversation">
      <ChatThread
        className={CONV_SCROLL_CLASS}
        messages={uiMessages}
        identity={{ name: who, initials: "SB" }}
        renderBody={(message) => {
          const event = eventById.get(message.id);
          if (event) {
            return (
              <span className={event.tone === "boundary" ? "event boundary conv-event conv-boundary" : "event conv-event"}>
                {event.text}
              </span>
            );
          }
          // The turn in flight reads as what the wait is for, in main's voice.
          if (message.id === "pending") return (
            <span className="think">
              <WorkingLabel stage={stage} />
            </span>
          );
          const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
          if (message.role === "user" && withdrawnIds.has(message.id)) {
            return (
              <div className="turn-withdrawn">
                <Markdown source={text} />
                <span className="turn-withdrawn-note">Stopped before it was answered.</span>
              </div>
            );
          }
          return (
            <>
              <span className="who conv-who">{message.role === "user" ? "You" : who}</span>
              <Markdown source={text} />
            </>
          );
        }}
        empty={<p className="inline-note">No messages yet.</p>}
      />
      <div className="composer" data-working={working || pending ? "" : undefined}>
        {rows}
        <Dictated value={value} onValueChange={onValueChange} disabled={disabled}>
        <ChatInput
          className={COMPOSER_BOX_CLASS}
          value={value}
          onValueChange={onValueChange}
          onSend={onSend}
          working={working || pending}
          {...(pending && onStop ? { onStop } : {})}
          {...(onSendHold ? { onSendHold } : {})}
          {...(onAttach ? { onAttach } : {})}
          disabled={disabled}
          placeholder={placeholder}
        />
        </Dictated>
        {popover}
      </div>
    </div>
  );
}

const EMPTY_WITHDRAWN: ReadonlySet<string> = new Set();
const EMPTY_EVENTS: readonly StageEvent[] = [];

/**
 * What the specialist is doing while it writes, in its own stage's terms. One
 * word for every stage read as a spinner; these say what the wait is for.
 */
export const STAGE_VERBS: Record<number, string[]> = {
  1: ["Listening", "Sharpening the problem", "Finding the real pain", "Writing the brief"],
  2: ["Drawing the boundaries", "Weighing constraints", "Naming the non-goals", "Writing"],
  3: ["Weighing trade-offs", "Comparing approaches", "Testing each against your criteria", "Writing"],
  4: ["Sketching", "Walking the flows", "Working out the states", "Writing"],
  5: ["Writing for each audience", "Making the case", "Writing"],
  6: ["Sequencing the work", "Sizing the steps", "Checking dependencies", "Writing"],
  7: ["Counting", "Costing the plan", "Checking the numbers", "Writing"],
};

/** The shimmering "working" word, rotating through the stage's verbs. */
export function WorkingLabel({
  stage = null,
  // Accepted so the document thread's pending row keeps typechecking until its
  // own convergence passes the stage through. The label itself follows main:
  // it says what the wait is for, never how long it has been.
  since = null,
}: {
  stage?: number | null;
  since?: string | null;
}) {
  void since;
  const verbs = (stage !== null && stage !== undefined ? STAGE_VERBS[stage] : undefined) ?? ["Writing"];
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (verbs.length < 2) return;
    const timer = setInterval(() => setAt((current) => (current + 1) % verbs.length), 3_200);
    return () => clearInterval(timer);
  }, [verbs.length]);
  return (
    <span className="thinking" key={at}>
      {verbs[at]}
    </span>
  );
}

/**
 * A specialist's turn ends in the question it is asking. Set apart from what
 * came before it, so a reader can tell what they are being asked from what
 * they are being told.
 */
export type TurnNote = {
  /** A person spoke just before this turn. */
  answered: boolean;
  version: number | null;
  nodeId: string | null;
  /** Opens a new round of questions after re-reading everything. */
  fresh: boolean;
  /** What the document is called, lower case: "problem brief", "constraints". */
  noun: string;
};

export function SpecialistTurn({
  text,
  note,
  onOpenVersion,
  onAnswer,
}: {
  text: string;
  note: TurnNote | null;
  onOpenVersion: (nodeId: string) => void;
  /** Set while the turn can be answered; a tapped option is sent as the answer. */
  onAnswer?: ((answer: string) => void) | undefined;
}) {
  // A turn that offers choices ends in the question and its options. One that
  // only asks ends in the question. Either way the question is set apart.
  const choices = choicesIn(text);
  const cut = text.lastIndexOf("\n\n");
  const last = (cut >= 0 ? text.slice(cut + 2) : text).trim();
  const question = choices?.question ?? (last.endsWith("?") ? last : null);
  const before = choices ? choices.before : question ? text.slice(0, Math.max(cut, 0)) : text;
  const options = choices?.options ?? [];
  return (
    <>
      {note ? (
        <p className="turn-note">
          {note.answered ? <span>Noted</span> : null}
          {note.version !== null && note.nodeId ? (
            <button type="button" className="turn-version" onClick={() => onOpenVersion(note.nodeId!)}>
              {note.noun} updated to v{note.version}
            </button>
          ) : null}
          {question ? <span>{note.fresh ? "new round of questions" : "next question"}</span> : null}
        </p>
      ) : null}
      {before.trim() ? <Markdown source={before} /> : null}
      {question ? <p className="turn-question">{question}</p> : null}
      {question && options.length > 0 ? (
        <div className="turn-options" role="group" aria-label="Likely answers">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="turn-option"
              disabled={!onAnswer}
              onClick={() => onAnswer?.(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
