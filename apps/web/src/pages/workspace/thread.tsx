import { useMemo } from "react";
import { ChatInput, ChatThread, type ChatMessage as UiChatMessage } from "@corbits/react-ui";
import { Markdown } from "../../markdown.jsx";
import { stageName } from "../../components.jsx";
import type { ChatMessage } from "../../stage-mail.ts";
import { choicesIn } from "./choices.js";
import { Elapsed } from "./elapsed.jsx";

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
}) {
  const uiMessages = useMemo(() => toUiMessages(messages), [messages]);
  return (
    <div className="stage-conversation">
      <ChatThread
        messages={uiMessages}
        identity={{ name: stageName(stage) }}
        renderBody={(message) => {
          const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
          if (message.role === "user" && withdrawnIds.has(message.id)) {
            return (
              <div className="turn-withdrawn">
                <Markdown source={text} />
                <span className="turn-withdrawn-note">Stopped before it was answered.</span>
              </div>
            );
          }
          return <Markdown source={text} />;
        }}
        empty={<p className="inline-note">No messages yet.</p>}
      />
      <ChatInput
        value={value}
        onValueChange={onValueChange}
        onSend={onSend}
        working={working || pending}
        {...(pending && onStop ? { onStop } : {})}
        disabled={disabled}
        placeholder={placeholder}
      />
    </div>
  );
}

const EMPTY_WITHDRAWN: ReadonlySet<string> = new Set();

/** A pending local send is evidence only that the browser has submitted a
 * message; it does not establish what the specialist is doing. The clock is
 * the one honest signal available without a token stream: time passing since
 * the message went out, not a guess at what the specialist is producing. */
export function WorkingLabel({ since = null }: { since?: string | null }) {
  return (
    <div className="thinking">
      <span>Message sent; waiting for a reply.</span>
      <Elapsed since={since} />
    </div>
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
