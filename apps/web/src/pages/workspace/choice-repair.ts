/**
 * Stage 3's choice, recorded in the draft whether or not the model did it
 * (#430). The gate reads a "## Chosen approach" heading; the person's
 * choice is the last chooser mail before the draft, named in its subject;
 * `ensureChoiceSection` (alpha main's repair) writes the section in when
 * the draft lacks it. Pure, so the rule is testable without React.
 */
import type { ChatMessage } from "../../stage-mail.ts";
import { ensureChoiceSection } from "@solutions-builder/app/stage-prompt";
import { chosenApproach } from "./composed-mail.ts";

export function repairedChoiceDraft(stage: number, messages: readonly ChatMessage[], draft: ChatMessage | null): ChatMessage | null {
  if (stage !== 3 || !draft) return draft;
  const at = messages.findIndex((message) => message.id === draft.id);
  const before = at === -1 ? messages : messages.slice(0, at);
  const choice = before.map(chosenApproach).findLast((name) => name !== null);
  if (!choice) return draft;
  const repaired = ensureChoiceSection(choice, draft.body);
  return repaired === draft.body ? draft : { ...draft, body: repaired };
}
