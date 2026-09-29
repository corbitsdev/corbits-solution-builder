/**
 * The reason a send-back carries, composed from the passages a person
 * queued from the document and whatever they typed. The passages lead: the
 * send-back is what they were attached for, so they go whether or not a
 * note was written. Pure, shared by the composer's hold-to-send picker and
 * the reader's "Change it" confirm (#248), so both send the same thing.
 */
export type QueuedPassage = { readonly quote: string; readonly note?: string | null | undefined };

export function composeSendBackReason(passages: readonly QueuedPassage[], draft: string): string {
  const quoted = passages.map((entry) => `> ${entry.note ? `${entry.quote}\n— ${entry.note}` : entry.quote}`);
  return [...quoted, draft.trim()].filter(Boolean).join("\n\n");
}
