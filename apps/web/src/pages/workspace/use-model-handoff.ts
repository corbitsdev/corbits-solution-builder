/**
 * CL-8899 "Switch model" + the general redeploy hand-off.
 *
 * A stage specialist's inference chain is frozen at deploy
 * (`sourceOfferingIds`, `specialist-deploy.ts`); there is no live rebind, so
 * moving it onto a different offering is a new deployment at a new address.
 * The durable switch record (`writeStageSwitch`, on the project tenant's own
 * config) is what makes every reader of the asset — `useStageAgent`'s own
 * poll included — resolve to the new one while it's live, and CL-8927's
 * merged thread read (`useStageThread`, across every address the stage has
 * ever run at) keeps the transcript from reading empty. But the NEW
 * deployment's own mailbox starts empty, so the specialist behind it has
 * nothing of the prior conversation to answer from until something is sent
 * to it.
 *
 * `useModelHandoff` is that something, and it fires for ANY redeploy of a
 * stage that already has history — an explicit "Switch model", a restart, a
 * recovery redeploy — not only the switch button: it watches `address`
 * against `addresses` (CL-8927's `useStageAgent.addresses`) and treats "the
 * live address changed, and other addresses already hold this stage's mail"
 * as the trigger, composing one hand-off mail (prior transcript + latest
 * draft, mirroring `composeStage9Opening`'s self-contained compose pattern)
 * to the new address. A brand-new stage has no prior addresses, so the
 * ordinary opening dispatch handles it instead — this never fires there.
 *
 * Idempotency has no atomic compare-and-set to lean on (mail send has no
 * "only if this address has never been written to" primitive), so this is
 * idempotent by CONTENT rather than by a true atomic claim: `handoffId` is
 * deterministic (a hash of the new address plus the prior transcript's own
 * head message id), embedded in a marker a specialist's own reply could not
 * plausibly reproduce (`[[sb-switch:<id>]]`, on its own line, and only ever
 * read back off a message authored by the person — `stage-events.ts`'s
 * `switchEvents` and `thread.tsx`'s marker-stripping both gate on that). The
 * pre-send check reads the new address's OWN thread (not the merged one)
 * and skips if it already holds ANY mail — since nothing but this hook ever
 * sends the first mail to a freshly switched-to address, that is sufficient
 * in the overwhelmingly common case. The read-then-send has an unavoidable
 * TOCTOU window (two tabs can both read "empty" before either sends): a true
 * atomic claim would need a hub primitive that does not exist, so a rare
 * benign duplicate is accepted rather than engineered around here. Because
 * `handoffId` is computed from the same inputs in both tabs, the two sends
 * that can result are byte-identical in their marker line, so a duplicate
 * is recognizably the same event rather than two different ones — and
 * `switchEvents` de-duplicates by `handoffId` when rendering the system
 * line, so the rare duplicate shows once even though two mails went out.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { isHtmlDocument } from "./guidance.ts";

/** The exact marker line's shape: `[[sb-switch:<hex id>]]`. Deliberately not
 *  the bare word "switch" or anything a specialist's own prose could
 *  plausibly type verbatim — paired with the author gate in
 *  `stage-events.ts`/`thread.tsx`, a specialist message is never mistaken
 *  for one of these regardless of what it says. */
const MARKER_RE = /^\[\[sb-switch:([0-9a-f]{1,8})\]\]$/;

/** A short, deterministic, synchronous hash (FNV-1a, 32-bit) — no crypto
 *  API needed for a collision-improbable, human-scannable id, and staying
 *  synchronous keeps `composeModelHandoff` synchronous too. */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Deterministic from (the new address, the prior transcript's own head) —
 *  two tabs racing the same redeploy compute the identical id. */
export function handoffId(address: string, priorHeadMessageId: string): string {
  return shortHash(`${address}|${priorHeadMessageId}`);
}

export function switchMarker(id: string): string {
  return `[[sb-switch:${id}]]`;
}

/** The id a switch-marker line names, or null if `line` isn't one. */
export function matchSwitchMarker(line: string): string | null {
  return MARKER_RE.exec(line.trim())?.[1] ?? null;
}

/** Long transcripts are condensed to the last 20 turns plus a count of what
 *  was dropped — enough for the new specialist to pick the thread back up
 *  without every hand-off ballooning into the entire stage history. */
const MAX_HANDOFF_TURNS = 20;
/** What the chat column shows for a hand-off mail in place of its recap:
 *  the recap is for the new specialist, and read back by a person it is
 *  the last twenty turns again, a whole HTML mockup included (#85). The
 *  boundary line from `stage-events.ts`'s `switchEvents` says which model
 *  the stage continued on. */
export const HANDOFF_BUBBLE_TEXT = "Handed the conversation so far, and the current draft, to the new specialist.";
/** A turn as the recap quotes it. A design reply is a whole HTML document
 *  (`kit.ts`), which quoted in full makes the recap unreadable and repeats
 *  the draft block below it, so it is named instead and the draft block
 *  alone carries the document (#85). */
function transcriptTurn(message: ChatMessage): string {
  const who = message.author === "me" ? "Person" : "Specialist";
  if (isHtmlDocument(message.body)) {
    return `${who}: (${message.author === "me" ? "shared" : "sent"} a design mockup as a whole HTML document; the current draft below is the latest one)`;
  }
  return `${who}: ${message.body}`;
}

function transcriptBlock(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) return "(No conversation yet.)";
  const kept = messages.length > MAX_HANDOFF_TURNS ? messages.slice(-MAX_HANDOFF_TURNS) : messages;
  const omitted = messages.length - kept.length;
  const lines = kept.map(transcriptTurn);
  return omitted > 0 ? [`(${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted.)`, ...lines].join("\n\n") : lines.join("\n\n");
}

export function composeModelHandoff(args: {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
  readonly draft: ChatMessage | null;
  readonly providerLabel: string | null;
  readonly modelName: string | null;
}): string {
  const onto = args.providerLabel && args.modelName ? ` on ${args.providerLabel} · ${args.modelName}` : "";
  const announcement = `${switchMarker(args.id)}\nThis stage continues${onto}.`;
  const recap = `Here is the conversation so far, so you can pick it up without restarting it:\n\n${transcriptBlock(args.messages)}`;
  const draftBlock = args.draft && args.draft.body.trim() ? `The current draft:\n\n${args.draft.body}` : null;
  return [announcement, recap, draftBlock].filter((part): part is string => part !== null).join("\n\n---\n\n");
}

/**
 * Whether a hand-off attempt is due for `address` right now: only once the
 * live address is known, other addresses already hold this stage's mail,
 * and the merged thread has actually loaded for the live address -- on a
 * reload the address arrives from a snapshot, the address list polls in,
 * and the thread read lands last, so judging the transcript before it has
 * loaded silently skipped the hand-off for good (#82). `priorHead` is the
 * merged thread's newest message once loaded.
 */
export function handoffDue(args: {
  readonly address: string | null;
  readonly addresses: readonly string[];
  readonly threadLoaded: boolean;
  readonly priorHead: ChatMessage | null;
}): boolean {
  if (!args.address) return false;
  if (!args.addresses.some((candidate) => candidate !== args.address)) return false;
  if (!args.threadLoaded) return false;
  return args.priorHead !== null;
}

/**
 * Whether the hand-off to `address` is in the transcript: a message the
 * person sent whose marker names this address and some earlier message as
 * the head it was composed against. Read off the merged thread, so it holds
 * on a reload long after the hand-off went.
 */
export function handoffLanded(address: string, messages: readonly ChatMessage[]): boolean {
  return messages.some((message, index) => {
    if (message.author !== "me") return false;
    const id = matchSwitchMarker(message.body.split("\n")[0] ?? "");
    if (!id) return false;
    return messages.slice(0, index).some((prior) => handoffId(address, prior.id) === id);
  });
}

/**
 * Whether anything else must wait before mailing `address`: a hand-off is
 * due for it and has not landed. The hand-off skips itself when the new
 * address already holds any mail, so a send-back cue that reached the
 * address first left the specialist with the cue and nothing of the
 * conversation or the draft it was meant to revise (#105).
 */
export function handoffPending(args: {
  readonly address: string | null;
  readonly addresses: readonly string[];
  readonly threadLoaded: boolean;
  readonly messages: readonly ChatMessage[];
}): boolean {
  const priorHead = args.messages.at(-1) ?? null;
  if (!handoffDue({ address: args.address, addresses: args.addresses, threadLoaded: args.threadLoaded, priorHead })) return false;
  return !handoffLanded(args.address!, args.messages);
}

export type ModelSwitchState = {
  readonly switching: boolean;
  readonly error: string | null;
  readonly switchTo: (offeringId: string) => Promise<void>;
};

/** Deploys the stage's specialist onto `offeringId` (CL-8899). Sends
 *  nothing itself — `useModelHandoff` below notices the live address moved
 *  and carries the conversation over. Rapid double-clicks/two tabs are
 *  serialized server-side (`switchSpecialistDeployment`'s own queue, keyed
 *  per project+stage); this hook does not need its own debounce beyond the
 *  disabled-while-switching flag it exposes. */
export function useModelSwitch(args: {
  readonly projectId: string;
  readonly stage: number;
}): ModelSwitchState {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchTo = async (offeringId: string) => {
    setSwitching(true);
    setError(null);
    try {
      await api.switchStageAgent(args.projectId, args.stage, offeringId);
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };

  return { switching, error, switchTo };
}

/**
 * Watches the stage's live address for a redeploy onto a stage that already
 * has mail under a different address, and sends the one hand-off mail that
 * carries the conversation over. See the module doc for the trigger and
 * idempotency rules.
 */
export function useModelHandoff(args: {
  readonly tenantId: string;
  readonly address: string | null;
  readonly addresses: readonly string[];
  readonly unionMessages: readonly ChatMessage[];
  /** `useStageThread`'s `loadedFor === address`: the merged transcript
   *  below reflects a read that landed for the live address. */
  readonly threadLoaded: boolean;
  readonly draft: ChatMessage | null;
  readonly providerLabel: string | null;
  readonly modelName: string | null;
  readonly reloadThread: () => Promise<void>;
}): { readonly error: string | null } {
  // Which address this hook has already resolved (sent to, or found already
  // handled) — never re-attempted for the same address.
  const resolvedRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A brand-new stage (no other address has ever held this stage's mail)
    // is the ordinary opening's job, not a hand-off; and nothing is judged
    // off a transcript that has not loaded for the live address yet (#82).
    const priorHead = args.unionMessages.at(-1) ?? null;
    if (!handoffDue({ address: args.address, addresses: args.addresses, threadLoaded: args.threadLoaded, priorHead })) return;
    if (!priorHead) return; // `handoffDue` already guarantees this; narrows the type.
    if (resolvedRef.current === args.address) return;

    let cancelled = false;
    void (async () => {
      try {
        // The new deployment's OWN thread, not the merged one -- an empty
        // merged thread is impossible here (priorAddresses is non-empty),
        // so idempotency has to ask the one address that would actually be
        // empty on a fresh deployment. See the module doc: this read-then-
        // send has a TOCTOU window this hook accepts rather than pretends
        // to close, since no atomic claim exists to close it with.
        const own = await api.readStageThread(args.tenantId, [args.address!]);
        if (cancelled) return;
        if (own.length > 0) {
          resolvedRef.current = args.address;
          return;
        }
        resolvedRef.current = args.address;
        const id = handoffId(args.address!, priorHead.id);
        const body = composeModelHandoff({
          id,
          messages: args.unionMessages,
          draft: args.draft,
          providerLabel: args.providerLabel,
          modelName: args.modelName,
        });
        await api.sendStageMail(args.tenantId, args.address!, { body });
        if (!cancelled) await args.reloadThread();
      } catch (cause) {
        if (!cancelled) {
          resolvedRef.current = null;
          setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // unionMessages (past its head)/draft/providerLabel/modelName/
    // reloadThread deliberately excluded: this must fire once per address
    // transition, off whatever those hold at that moment, not re-run every
    // time the transcript changes underneath it. `threadLoaded` IS a dep:
    // it is the one signal that the transcript is there to read at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.address, args.addresses.join(","), args.tenantId, args.threadLoaded]);

  return { error };
}
