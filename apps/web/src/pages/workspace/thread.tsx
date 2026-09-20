import { useMemo } from "react";
import { ChatInput, ChatThread, type ChatMessage as UiChatMessage } from "@corbits/react-ui";
import { Markdown } from "../../markdown.jsx";
import { stageName } from "../../components.jsx";
import type { ChatMessage } from "../../stage-mail.ts";
import { choicesIn } from "./choices.js";

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
}) {
  const uiMessages = useMemo(() => toUiMessages(messages), [messages]);
  return (
    <div className="stage-conversation">
      <ChatThread
        messages={uiMessages}
        identity={{ name: stageName(stage) }}
        renderBody={(message) => <Markdown source={message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")} />}
        empty={<p className="inline-note">No messages yet.</p>}
      />
      <ChatInput
        value={value}
        onValueChange={onValueChange}
        onSend={onSend}
        working={working}
        disabled={disabled}
        placeholder={placeholder}
      />
    </div>
  );
}

/** A pending local send is evidence only that the browser has submitted a
 * message; it does not establish what the specialist is doing. */
export function WorkingLabel() {
  return <span className="thinking">Message sent; waiting for a reply.</span>;
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
