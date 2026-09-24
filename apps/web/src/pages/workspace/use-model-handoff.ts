/**
 * CL-8899 "Switch model" + the general redeploy hand-off.
 *
 * A stage specialist's inference chain is frozen at deploy
 * (`sourceOfferingIds`, `specialist-deploy.ts`); there is no live rebind, so
 * moving it onto a different offering is a new deployment at a new address.
 * `pickDeployment`'s newest-wins tie-break makes every reader of the asset —
 * `useStageAgent`'s own poll included — resolve to it, and CL-8927's merged
 * thread read (`useStageThread`, across every address the stage has ever
 * run at) keeps the transcript from reading empty. But the NEW deployment's
 * own mailbox starts empty, so the specialist behind it has nothing of the
 * prior conversation to answer from until something is sent to it.
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
 * Idempotent by construction: it checks the new address's OWN thread (not
 * the merged one) before sending, so a reload or a second mount that finds
 * mail already there skips silently, and the opening guard is untouched —
 * `use-opening-dispatch.ts` reads the merged thread, which is already
 * non-empty once history exists, so it never re-fires here either.
 *
 * The hand-off's first line is a `[switch]` marker; `stage-events.ts`'s
 * `switchEvents` reads it back off the sent mail to render the system line
 * in the transcript -- the record is the mail itself, nothing is
 * synthesized only for display.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";

export const SWITCH_MARKER_PREFIX = "[switch]";

/** Long transcripts are condensed to the last 20 turns plus a count of what
 *  was dropped — enough for the new specialist to pick the thread back up
 *  without every hand-off ballooning into the entire stage history. */
const MAX_HANDOFF_TURNS = 20;

function transcriptBlock(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) return "(No conversation yet.)";
  const kept = messages.length > MAX_HANDOFF_TURNS ? messages.slice(-MAX_HANDOFF_TURNS) : messages;
  const omitted = messages.length - kept.length;
  const lines = kept.map((message) => `${message.author === "me" ? "Person" : "Specialist"}: ${message.body}`);
  return omitted > 0 ? [`(${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted.)`, ...lines].join("\n\n") : lines.join("\n\n");
}

export function composeModelHandoff(args: {
  readonly messages: readonly ChatMessage[];
  readonly draft: ChatMessage | null;
  readonly providerLabel: string | null;
  readonly modelName: string | null;
}): string {
  const onto = args.providerLabel && args.modelName ? ` on ${args.providerLabel} · ${args.modelName}` : "";
  const announcement = `${SWITCH_MARKER_PREFIX} This stage continues${onto}.`;
  const recap = `Here is the conversation so far, so you can pick it up without restarting it:\n\n${transcriptBlock(args.messages)}`;
  const draftBlock = args.draft && args.draft.body.trim() ? `The current draft:\n\n${args.draft.body}` : null;
  return [announcement, recap, draftBlock].filter((part): part is string => part !== null).join("\n\n---\n\n");
}

export type ModelSwitchState = {
  readonly switching: boolean;
  readonly error: string | null;
  readonly switchTo: (offeringId: string) => Promise<void>;
};

/** Deploys the stage's specialist onto `offeringId` (CL-8899). Sends
 *  nothing itself — `useModelHandoff` below notices the live address moved
 *  and carries the conversation over. */
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
    if (!args.address) return;
    const priorAddresses = args.addresses.filter((candidate) => candidate !== args.address);
    // A brand-new stage (no other address has ever held this stage's mail)
    // is the ordinary opening's job, not a hand-off.
    if (priorAddresses.length === 0) return;
    if (resolvedRef.current === args.address) return;

    let cancelled = false;
    void (async () => {
      try {
        // The new deployment's OWN thread, not the merged one -- an empty
        // merged thread is impossible here (priorAddresses is non-empty),
        // so idempotency has to ask the one address that would actually be
        // empty on a fresh deployment.
        const own = await api.readStageThread(args.tenantId, [args.address!]);
        if (cancelled) return;
        if (own.length > 0) {
          resolvedRef.current = args.address;
          return;
        }
        resolvedRef.current = args.address;
        const body = composeModelHandoff({
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
    // unionMessages/draft/providerLabel/modelName/reloadThread deliberately
    // excluded: this must fire once per address transition, off whatever
    // those hold at that moment, not re-run every time the transcript
    // changes underneath it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.address, args.addresses.join(","), args.tenantId]);

  return { error };
}
