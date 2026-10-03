/**
 * Which reply on the stage 5 thread answers the package request just sent
 * for one stakeholder. Every stakeholder's package is asked of the one
 * stage 5 deployment (#41 step 3), so two requests in flight share the
 * thread, and "the next agent turn" could be either's answer.
 */
import { packageAudienceOf } from "./pages/workspace/composed-mail.ts";
import type { ChatMessage } from "./stage-mail.ts";
import { pairReplies } from "./withdrawn-turns.ts";

/**
 * The request for `name`'s package sent after everything in `seenIds`, and
 * the reply `pairReplies` pairs with it: by the trigger id the hub recorded
 * on the request (#62) when it has one, else by order, one mail-triggered
 * turn at a time. Null while the request has not shown on the thread, or
 * has no paired reply yet.
 */
export function packageReplyFor(messages: readonly ChatMessage[], seenIds: ReadonlySet<string>, name: string): ChatMessage | null {
  const request = messages.find((message) => !seenIds.has(message.id) && packageAudienceOf(message) === name);
  if (!request) return null;
  const { answeredBy } = pairReplies(messages);
  return messages.find((message) => message.author === "agent" && answeredBy.get(message.id) === request.id) ?? null;
}
