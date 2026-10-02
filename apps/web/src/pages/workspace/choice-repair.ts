/**
 * Stage 3's choice, recorded in the draft whether or not the model did it
 * (#430). The gate reads a "## Chosen approach" heading; the person's
 * choice is the last of their turns before the draft that starts with
 * "Chosen:"; `ensureChoiceSection` (alpha main's repair) writes the section
 * in when the draft lacks it. Pure, so the rule is testable without React.
 */
import type { ChatMessage } from "../../stage-mail.ts";
import { ensureChoiceSection, splitRevision } from "@solutions-builder/app/stage-prompt";

/** The person's words in a turn, whatever the app wrapped around them. */
function askOf(message: ChatMessage): string {
  return (splitRevision(message.body)?.ask ?? message.body).trim();
}

export function repairedChoiceDraft(stage: number, messages: readonly ChatMessage[], draft: ChatMessage | null): ChatMessage | null {
  if (stage !== 3 || !draft) return draft;
  const at = messages.findIndex((message) => message.id === draft.id);
  const before = at === -1 ? messages : messages.slice(0, at);
  const choice = [...before].reverse().find((message) => message.author === "me" && /^chosen:/i.test(askOf(message)));
  if (!choice) return draft;
  const repaired = ensureChoiceSection(3, askOf(choice), draft.body);
  return repaired === draft.body ? draft : { ...draft, body: repaired };
}
