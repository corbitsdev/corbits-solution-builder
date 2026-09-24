import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChatInput, type ChatMessage as UiChatMessage } from "@corbits/react-ui";
import { Plus, Send } from "lucide-react";
import { Markdown } from "../../markdown.jsx";
import { Dictated } from "../../dictation.jsx";
import type { ChatMessage } from "../../stage-mail.ts";
import { choicesIn } from "./choices.js";
import { conversationLead, isHtmlDocument } from "./guidance.js";
import { eventMessages, type StageEvent } from "./stage-events.ts";
import { COMPOSER_BOX_CLASS, CONV_SCROLL_CLASS } from "./pane-classes.ts";

/** A stage-mail turn as a chat row. The specialist's long draft lives in the
 *  right pane, not here — the mockup keeps chat to short status lines. */
function toUiMessages(messages: readonly ChatMessage[]): UiChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.author === "me" ? "user" : "agent",
    parts: [{ type: "text", text: message.author === "me" ? message.body : conversationLead(message.body) }],
    createdAt: message.at,
  }));
}

/**
 * A message body as the person reads it. A stage after the first opens with
 * the previous stage's approved artifact as the person's own first mail
 * (`use-opening-dispatch.ts`); at stage 5 that is the stage 4 design, an
 * HTML document, which Markdown would show as a wall of markup. It is shown
 * the way the design page shows it: in a frame with no scripts and no
 * same-origin, since a generated design is untrusted. Everything else is
 * Markdown as before.
 */
function MessageBody({ text }: { text: string }) {
  if (isHtmlDocument(text)) {
    return <iframe className="bubble-document" title="The approved design" srcDoc={text} sandbox="" />;
  }
  return <Markdown source={text} />;
}

function messageText(message: UiChatMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [uiMessages]);

  return (
    <div className="stage-conversation">
      {uiMessages.length === 0 ? (
        <div className={CONV_SCROLL_CLASS}>
          <p className="inline-note">No messages yet.</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={CONV_SCROLL_CLASS}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          onScroll={(event) => {
            const node = event.currentTarget;
            pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
          }}
        >
          {uiMessages.map((message) => {
            const event = eventById.get(message.id);
            if (event) {
              return (
                <div
                  key={message.id}
                  className={event.tone === "boundary" ? "event boundary conv-event conv-boundary" : "event conv-event"}
                >
                  {event.text}
                </div>
              );
            }
            if (message.id === "pending") {
              return (
                <div key={message.id} className="think">
                  <span className="who conv-who">{who}</span>
                  <WorkingLabel />
                </div>
              );
            }
            const text = messageText(message);
            const you = message.role === "user";
            return (
              <div key={message.id} className={you ? "msg you" : "msg"}>
                <span className="who conv-who">{you ? "You" : who}</span>
                <div className="bubble">
                  {you && withdrawnIds.has(message.id) ? (
                    <div className="turn-withdrawn">
                      <MessageBody text={text} />
                      <span className="turn-withdrawn-note">Stopped before it was answered.</span>
                    </div>
                  ) : (
                    <MessageBody text={text} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="composer" data-working={working || pending ? "" : undefined}>
        {rows}
        <Dictated value={value} onValueChange={onValueChange} disabled={disabled}>
        {(mic) => (
        <ChatInput
          className={COMPOSER_BOX_CLASS}
          value={value}
          onValueChange={onValueChange}
          onSend={onSend}
          working={working || pending}
          {...(pending && onStop ? { onStop } : {})}
          {...(onSendHold ? { onSendHold } : {})}
          {...(onAttach ? { onAttach } : {})}
          attachIcon={<Plus className="size-4" aria-hidden="true" />}
          sendIcon={<Send className="size-4" aria-hidden="true" />}
          leadingTools={mic}
          disabled={disabled}
          placeholder={placeholder}
        />
        )}
        </Dictated>
        {popover}
      </div>
    </div>
  );
}

const EMPTY_WITHDRAWN: ReadonlySet<string> = new Set();
const EMPTY_EVENTS: readonly StageEvent[] = [];

/** One calm, honest line while the specialist writes — no cycling phrases
 *  presented as live activity (CL-8726). The turn's own "who" label already
 *  names the specialist, so this just says what's happening. */
export function WorkingLabel() {
  return <span className="thinking">Working on it…</span>;
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
