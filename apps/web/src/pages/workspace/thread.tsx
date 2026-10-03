import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ChatInput, type ChatMessage as UiChatMessage } from "@corbits/react-ui";
import { FileText, Plus, Send } from "lucide-react";
import { Markdown } from "../../markdown.jsx";
import { splitHandoff } from "../../design-handoff.ts";
import { splitChain } from "./approved-chain.ts";
import { composedMailFold, type ComposedFold } from "./composed-mail.ts";
import { personWordsIn, REVISION_LEAD } from "@solutions-builder/app/stage-prompt";
import { Dictated } from "../../dictation.jsx";
import type { ChatMessage } from "../../stage-mail.ts";
import { answersDraft, segmentsIn } from "./choices.js";
import { DRAFT_POINTER, conversationLead, isHtmlDocument } from "./guidance.js";
import type { DraftRef } from "./draft-references.ts";
import { eventMessages, type StageEvent } from "./stage-events.ts";
import { HANDOFF_BUBBLE_TEXT, isHandoffBody } from "./use-model-handoff.ts";
import { COMPOSER_BOX_CLASS, CONV_SCROLL_CLASS } from "./pane-classes.ts";

/** A model hand-off's `[[sb-switch:<id>]]` marker line, rendered separately
 *  as a system boundary line (`stage-events.ts`'s `switchEvents`) — dropped
 *  here so the bubble doesn't repeat the raw id. Gated on `author === "me"`
 *  (the hand-off's own sender, same as `switchEvents`): a specialist-
 *  authored message is never inspected for the marker, so nothing a
 *  specialist writes can ever have its content stripped by this.
 */
export function withoutSwitchMarker(message: ChatMessage): string {
  if (message.author !== "me") return message.body;
  if (!isHandoffBody(message.body)) return message.body;
  // The recap and draft it carries are for the new specialist; read back
  // by a person they were the last twenty turns over again, a whole HTML
  // mockup included (#85). One line says what the mail did instead.
  return HANDOFF_BUBBLE_TEXT;
}

/** A stage-mail turn as a chat row. The specialist's long draft lives in the
 *  right pane, not here — the mockup keeps chat to short status lines. */
function toUiMessages(messages: readonly ChatMessage[]): UiChatMessage[] {
  return messages.map((message) => {
    const body = withoutSwitchMarker(message);
    return {
      id: message.id,
      role: message.author === "me" ? "user" : "agent",
      parts: [{ type: "text", text: message.author === "me" ? body : conversationLead(body) }],
      createdAt: message.at,
    };
  });
}

/**
 * A message body as the person reads it. A stage after the first opens with
 * the previous stage's approved artifact as the person's own first mail
 * (`use-opening-dispatch.ts`); at stage 5 that is the stage 4 design, and
 * each package request carries it again as text (#221). Shown in full it is
 * a screen-tall block the chat opens on (#301), so the design travels
 * folded: the ask, then a disclosure that opens on demand. A message that
 * is itself an HTML document folds the same way, its frame inside, with no
 * scripts and no same-origin since a generated design is untrusted.
 * Everything else is Markdown as before.
 */
export function MessageBody({ text }: { text: string }) {
  if (isHtmlDocument(text)) {
    return (
      <details className="bubble-fold">
        <summary>The approved design</summary>
        <iframe className="bubble-document" title="The approved design" srcDoc={text} sandbox="" />
      </details>
    );
  }
  // An opening that carries the approved chain (#423) folds it the same
  // way: the record on demand, then what this stage opens with.
  const chain = splitChain(text);
  if (chain) {
    return (
      <>
        {chain.before ? <Markdown source={chain.before} /> : null}
        <details className="bubble-fold">
          <summary>What was approved before this stage</summary>
          <Markdown source={chain.chain} />
        </details>
        {chain.after ? <MessageBody text={chain.after} /> : null}
      </>
    );
  }
  // A model hand-off quotes the earlier turns, revision markers included,
  // so it is named for what it is before anything reads it for the person's
  // words.
  if (isHandoffBody(text)) return <Markdown source={HANDOFF_BUBBLE_TEXT} />;
  // A message the app composed around the person's words (the version it
  // revises, an attached document, a choice reminder) shows only those
  // words; what the app added stays behind a fold.
  const composed = personWordsIn(text);
  if (composed) {
    return (
      <>
        <Markdown source={composed.words} />
        <details className="bubble-fold">
          <summary>{composed.added.startsWith(REVISION_LEAD) ? "The version this revises" : "What the app sent with this"}</summary>
          <Markdown source={composed.added} />
        </details>
      </>
    );
  }
  const handoff = splitHandoff(text);
  if (handoff) {
    return (
      <>
        {handoff.lead ? <Markdown source={handoff.lead} /> : null}
        <details className="bubble-fold">
          <summary>The approved design, as text</summary>
          <Markdown source={handoff.attached} />
        </details>
      </>
    );
  }
  return <Markdown source={text} />;
}

/** A mail the app composed in the person's name: its one line, and what it carried behind a disclosure. */
export function ComposedMail({ fold }: { fold: ComposedFold }) {
  return (
    <>
      {fold.lead ? <Markdown source={fold.lead} /> : null}
      {fold.summary ? (
        <details className="bubble-fold">
          <summary>{fold.summary}</summary>
          <MessageBody text={fold.body} />
        </details>
      ) : null}
    </>
  );
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
  draftRefs = EMPTY_REFS,
  onOpenVersion,
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
  /** Which version each draft reply became (#158): such a reply is one line
   *  naming its version, never the draft itself. */
  draftRefs?: ReadonlyMap<string, DraftRef>;
  /** Opens a draft line's version in the document pane. */
  onOpenVersion?: ((nodeId: string) => void) | undefined;
}) {
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
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
            const draft = you ? null : (draftRefs.get(message.id) ?? null);
            const source = byId.get(message.id);
            const composed = source ? composedMailFold(source) : null;
            return (
              <div key={message.id} className={you ? "msg you" : "msg"}>
                <span className="who conv-who">{you ? "You" : who}</span>
                <div className="bubble">
                  {composed ? (
                    <ComposedMail fold={composed} />
                  ) : you && withdrawnIds.has(message.id) ? (
                    <div className="turn-withdrawn">
                      <MessageBody text={text} />
                      <span className="turn-withdrawn-note">Stopped before it was answered.</span>
                    </div>
                  ) : draft ? (
                    <>
                      <DraftReference draft={draft} onOpen={onOpenVersion} />
                      {text === DRAFT_POINTER ? null : <MessageBody text={text} />}
                    </>
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
const EMPTY_REFS: ReadonlyMap<string, DraftRef> = new Map();

/**
 * A draft reply's line in the chat (#158): "Drafted v2 of the problem
 * brief", opening that version in the document pane. The draft's own text
 * and headings never repeat here; the pane is the one place they show. A
 * draft whose version is not recorded yet is named without a version, and
 * the line has nothing to open.
 */
export function DraftReference({ draft, onOpen }: { draft: DraftRef; onOpen?: ((nodeId: string) => void) | undefined }) {
  const label = draft.version !== null ? `Drafted v${draft.version} of the ${draft.noun}` : `Drafted the ${draft.noun}`;
  const nodeId = draft.nodeId;
  return (
    <p className="turn-draft">
      <FileText className="size-3.5" aria-hidden="true" />
      {nodeId && onOpen ? (
        <button type="button" className="turn-version" onClick={() => onOpen(nodeId)}>
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
    </p>
  );
}

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
  draft = null,
  onOpenVersion,
  onAnswer,
  busy = false,
  onDraft,
}: {
  text: string;
  note: TurnNote | null;
  /** Set when the turn is a draft (#158): the chat shows one line naming
   *  its version and the questions the turn asks, and the draft's text and
   *  headings stay in the document pane. */
  draft?: DraftRef | null;
  onOpenVersion: (nodeId: string) => void;
  /** Set while the turn can be answered -- the latest turn, nothing said
   *  since: sent once every question the turn asks has a tapped answer. A
   *  lone question sends on its tap. Absent, the questions show without
   *  their options: an answered turn offers nothing to tap. */
  onAnswer?: ((answer: string) => void) | undefined;
  /** Set while the page is working on something else, such as an approval:
   *  the latest turn's options stay on screen but cannot be tapped. */
  busy?: boolean;
  /** The answers so far, while some question is still unanswered: what the
   *  message box should hold, so the person sees them gather and can add
   *  to them (#142). Absent, a partial set is sent as it stands. */
  onDraft?: ((draft: string) => void) | undefined;
}) {
  // Every question the turn asks is set apart with its own options -- a
  // turn that lists two under "What I need from you" has asked two, and
  // each must be answerable (`segmentsIn`).
  const segments = useMemo(() => segmentsIn(text), [text]);
  const questions = useMemo(() => segments.filter((segment) => segment.kind === "question"), [segments]);
  const question = questions.length > 0;
  // What has been tapped for each question, by its place among the turn's
  // questions. Local to the turn: once answered, the turn is no longer the
  // one being answered and its chips go.
  const [chosen, setChosen] = useState<ReadonlyMap<number, string>>(() => new Map());
  const choose = (questionIndex: number, option: string) => {
    const next = new Map(chosen);
    next.set(questionIndex, option);
    setChosen(next);
    const draft = answersDraft(questions, next);
    if (draft.complete || !onDraft) onAnswer?.(draft.text);
    else onDraft(draft.text);
  };
  let questionIndex = -1;
  // A draft's lead -- the sentence or two before its first heading -- is
  // conversation and stays; the pointer that stands in when there is no
  // lead is what the draft line already says.
  const lead = draft ? conversationLead(text) : null;
  return (
    <>
      {note ? (
        <p className="turn-note">
          {note.answered ? <span>Noted</span> : null}
          {note.version !== null && note.nodeId && !draft ? (
            <button type="button" className="turn-version" onClick={() => onOpenVersion(note.nodeId!)}>
              {note.noun} updated to v{note.version}
            </button>
          ) : null}
          {question ? <span>{note.fresh ? "new round of questions" : "next question"}</span> : null}
        </p>
      ) : null}
      {draft ? <DraftReference draft={draft} onOpen={onOpenVersion} /> : null}
      {lead !== null && lead !== DRAFT_POINTER ? <Markdown source={lead} /> : null}
      {segments.map((segment, index) => {
        if (segment.kind === "text") return draft ? null : <Markdown key={index} source={segment.markdown} />;
        const at = ++questionIndex;
        const picked = chosen.get(at);
        return (
          <div key={index} className="turn-ask">
            <p className="turn-question">{segment.question}</p>
            {segment.options.length > 0 && onAnswer ? (
              <div className="turn-options" role="group" aria-label="Likely answers">
                {segment.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="turn-option"
                    disabled={busy}
                    aria-pressed={picked === option}
                    onClick={() => choose(at, option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
