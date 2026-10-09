/**
 * Sends the stage's specialist the material attached after its opening
 * went out (#607). What is owed, and the mail that carries it, are
 * `attached-material.ts`'s; this only decides when to send.
 *
 * It waits for the thread to have loaded for the live address, for a
 * redeployed specialist's hand-off to land first (the same order the
 * send-back cue keeps, #105), and for a turn in flight to finish, so the
 * material arrives as a turn of its own against the latest draft.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiFailure, type ArtifactNode } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import { revisionRequest } from "@solutions-builder/app/stage-prompt";
import { readHandedItems } from "./approved-chain.ts";
import { composeMaterialMail, owedMaterial } from "./attached-material.ts";
import type { ChainNode } from "./approved-chain.ts";
import { handoffPending } from "./use-model-handoff.ts";

/**
 * What to send now, or nothing: the gate, apart from the hook so it can be
 * tested without one.
 */
export function materialToSend(input: {
  readonly agentAddress: string | null;
  readonly addresses: readonly string[];
  /** `useModelHandoff.settled` (#718); the hand-off's own verdict. */
  readonly handoffSettled?: boolean;
  readonly loadedFor: string | null;
  readonly busy: boolean;
  readonly nodes: readonly ChainNode[];
  readonly messages: readonly ChatMessage[];
}): ChainNode[] {
  const { agentAddress, addresses, handoffSettled, loadedFor, busy, nodes, messages } = input;
  if (!agentAddress || loadedFor !== agentAddress || messages.length === 0 || busy) return [];
  if (handoffPending({ address: agentAddress, addresses, threadLoaded: true, messages: [...messages], settled: handoffSettled ?? false })) return [];
  return owedMaterial({ nodes, messages });
}

export function useMaterialDispatch({
  tenantId,
  stage,
  nodes,
  agentAddress,
  addresses,
  handoffSettled,
  messages,
  loadedFor,
  busy,
  revising,
  reloadThread,
}: {
  tenantId: string;
  stage: number;
  nodes: readonly ArtifactNode[];
  /** Already scoped to the current stage by `useStageAgent`. */
  agentAddress: string | null;
  /** Every address this stage's mail has lived at. */
  addresses: readonly string[];
  handoffSettled: boolean;
  /** The thread as loaded, withdrawn turns included: a stopped turn was still sent. */
  messages: readonly ChatMessage[];
  loadedFor: string | null;
  /** The specialist is working on a turn. */
  busy: boolean;
  /** The Markdown draft on the table, which a turn revises rather than
   *  re-rolls (#431); null when there is none, or the stage revises nothing. */
  revising: string | null;
  reloadThread: () => Promise<void>;
}): { readonly error: string | null } {
  // The owed set last tried at this address. A send that failed is not
  // tried again for the same files on its own: another file, another
  // address or a reopened project tries again.
  const attemptedRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const owed = materialToSend({ agentAddress, addresses, handoffSettled, loadedFor, busy, nodes, messages });
    if (!agentAddress || owed.length === 0) return;
    const key = `${agentAddress}:${owed.map((node) => node.id).join(",")}`;
    if (attemptedRef.current === key) return;
    attemptedRef.current = key;
    void (async () => {
      // Read again just before sending: another window on the same
      // project may have sent these while this one was getting here.
      const thread = await api.readStageThread(tenantId, addresses.length > 0 ? [...addresses] : [agentAddress]);
      const items = await readHandedItems(tenantId, owedMaterial({ nodes: owed, messages: thread }));
      if (items.length === 0) return;
      const turn = composeMaterialMail(items, stage);
      const body = revising !== null ? revisionRequest({ stage, userInput: turn, currentDocument: revising }) : turn;
      await api.sendStageMail(tenantId, agentAddress, { body });
      setError(null);
      await reloadThread();
    })().catch((cause: unknown) => {
      setError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    });
  }, [tenantId, stage, nodes, agentAddress, addresses, handoffSettled, messages, loadedFor, busy, revising, reloadThread]);

  // One stage's failure is not the next one's.
  useEffect(() => {
    setError(null);
  }, [stage, agentAddress]);

  return { error };
}
