/**
 * Whether the stage's live specialist has what it works from, and the way
 * to give it that when it has not (#804).
 *
 * A specialist is briefed by its stage's opening, by the hand-off that
 * follows a redeploy, or by a send-back cue that carries the record. Each
 * of those can fail to arrive, and a specialist then answers from whatever
 * mail did reach it; one that got a one-line send-back and nothing else
 * said so in its reply and then redrew a different product. Nothing read
 * the reply. This hook reads the specialist's own thread instead: when it
 * holds mail but no briefing, the stage cannot be approved, and one click
 * sends the briefing by hand, the record before this stage and the current
 * draft, the same content a hand-off carries.
 *
 * Read off the live address's own thread, never the merged one, since the
 * merged thread always holds the stage's history under earlier addresses.
 * Nothing is judged while a hand-off is still due: that is about to brief
 * it. Pure parts (`briefingState`, `composeBriefing`) carry the rules.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure, type ArtifactNode } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import type { ReviewState } from "@solutions-builder/app/project-workflow/contracts";
import { stageName } from "../../components.jsx";
import { approvedChainQuery } from "./approved-chain.ts";
import { queryClient } from "../../queries/client.ts";
import { HANDOFF_CLOSE, handoffPending, specialistBriefed } from "./use-model-handoff.ts";

export type BriefingState = "unknown" | "briefed" | "unbriefed";

/**
 * What the specialist's own thread says: unknown while there is nothing
 * to judge (no mail yet, or a hand-off still due), briefed when a
 * briefing is there, unbriefed when mail is there and no briefing is.
 */
export function briefingState(ownThread: readonly Pick<ChatMessage, "author" | "body" | "subject">[], handoffStillDue: boolean): BriefingState {
  if (handoffStillDue) return "unknown";
  if (ownThread.length === 0) return "unknown";
  return specialistBriefed(ownThread) ? "briefed" : "unbriefed";
}

export const BRIEFING_LEAD = "You were started without the project's record. Here it is, so your work is checked against what the person approved rather than reconstructed from memory.";

/** The subject a hand briefing carries; `specialistBriefed` reads it back. */
export function briefingSubject(projectId: string, stage: number): string {
  return `[briefing:${projectId}:${stage}] ${stageName(stage)}`;
}

/** The briefing's body: the lead, the record, the current draft, and what to do next. */
export function composeBriefing(args: { readonly record: string; readonly draft: string | null }): string {
  const parts = [BRIEFING_LEAD];
  if (args.record.trim()) parts.push(args.record.trim());
  if (args.draft?.trim()) parts.push(`The current draft:\n\n${args.draft.trim()}`);
  parts.push(HANDOFF_CLOSE);
  return parts.join("\n\n---\n\n");
}

export type SpecialistBriefing = {
  readonly state: BriefingState;
  readonly sending: boolean;
  readonly error: string | null;
  readonly brief: () => Promise<void>;
};

export function useSpecialistBriefing(args: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly stage: number;
  readonly address: string | null;
  readonly addresses: readonly string[];
  /** `useStageThread`'s `loadedFor === address`. */
  readonly threadLoaded: boolean;
  /** The merged thread; what the hand-off is judged against, and whose person turns say when to look again. */
  readonly messages: readonly ChatMessage[];
  readonly draft: ChatMessage | null;
  readonly nodes: readonly ArtifactNode[];
  readonly reviews: Readonly<Record<number, ReviewState | undefined>>;
  readonly reloadThread: () => Promise<void>;
}): SpecialistBriefing {
  const [state, setState] = useState<BriefingState>("unknown");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const judgedFor = useRef<string | null>(null);

  const personTurns = args.messages.filter((message) => message.author === "me").length;
  const stillDue = handoffPending({ address: args.address, addresses: args.addresses, threadLoaded: args.threadLoaded, messages: args.messages });

  useEffect(() => {
    if (!args.address || !args.threadLoaded) {
      setState("unknown");
      return;
    }
    if (stillDue) {
      setState("unknown");
      return;
    }
    let cancelled = false;
    const address = args.address;
    void api
      .readStageThread(args.tenantId, [address])
      .then((own) => {
        if (cancelled) return;
        judgedFor.current = address;
        setState(briefingState(own, false));
      })
      .catch(() => {
        // Not judged: nothing is blocked on a read that failed.
        if (!cancelled) setState("unknown");
      });
    return () => {
      cancelled = true;
    };
    // Judged again when the live address changes, the thread loads for it,
    // or a person turn lands (a briefing or hand-off is one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.address, args.threadLoaded, stillDue, personTurns, args.tenantId]);

  const brief = useCallback(async () => {
    if (!args.address) return;
    setSending(true);
    setError(null);
    try {
      const record = await queryClient.fetchQuery(approvedChainQuery({ tenantId: args.tenantId, nodes: args.nodes, reviews: args.reviews, stage: args.stage + 1 })).catch(() => "");
      const body = composeBriefing({ record, draft: args.draft?.body ?? null });
      await api.sendStageMail(args.tenantId, args.address, { body, subject: briefingSubject(args.projectId, args.stage) });
      setState("briefed");
      await args.reloadThread();
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    } finally {
      setSending(false);
    }
  }, [args.address, args.tenantId, args.nodes, args.reviews, args.stage, args.draft, args.projectId, args.reloadThread]);

  return { state, sending, error, brief };
}
