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
 * the reply `pairReplies` pairs with it by the trigger id the hub recorded
 * on the request (#62). Null while the request has not shown on the thread,
 * or has no paired reply yet.
 */
export function packageReplyFor(messages: readonly ChatMessage[], seenIds: ReadonlySet<string>, name: string): ChatMessage | null {
  const request = messages.find((message) => !seenIds.has(message.id) && packageAudienceOf(message) === name);
  if (!request) return null;
  const { answeredBy } = pairReplies(messages);
  return messages.find((message) => message.author === "agent" && answeredBy.get(message.id) === request.id) ?? null;
}

/**
 * The messages ahead of the newest request for `name`'s package, when that
 * request is still unanswered or was answered after the package last recorded
 * at `recordedAt`: the `seenIds` `packageReplyFor` reads its reply back with.
 * Null when there is no such request. A reload drops the page's wait on a
 * request in flight, and with it the recording of its reply; this is what
 * picks it back up instead of asking again.
 */
export function unrecordedPackageRequest(messages: readonly ChatMessage[], name: string, recordedAt: string | null): ReadonlySet<string> | null {
  const at = messages.findLastIndex((message) => packageAudienceOf(message) === name);
  if (at === -1) return null;
  const seenIds = new Set(messages.slice(0, at).map((message) => message.id));
  const latest = packageReplyFor(messages, seenIds, name) ?? messages[at]!;
  if (recordedAt !== null && Date.parse(latest.at) <= Date.parse(recordedAt)) return null;
  return seenIds;
}
