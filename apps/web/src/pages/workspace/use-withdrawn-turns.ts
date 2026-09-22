/**
 * Stop's durable marker (CL-8695): one per-project artifact, read with the
 * rest of this project's artifacts so a withdrawn turn stays withdrawn across
 * a refresh or a second browser. The fold runs before anything reads the
 * thread, so a reply Stop hid can never surface as the latest turn, the
 * draft, or the open question.
 */
import { useEffect, useMemo, useState } from "react";
import { api, ApiFailure, type ArtifactNode } from "../../client.js";
import type { ChatMessage } from "../../stage-mail.ts";
import {
  applyWithdrawn,
  parseWithdrawnTurns,
  pendingTurn,
  WITHDRAWN_TURNS_KIND,
  type WithdrawnMark,
} from "../../withdrawn-turns.ts";

export type WithdrawnTurnsState = {
  /** The thread with withdrawn turns folded out — everything downstream
   *  (draft detection, open question, awaiting-reply) reads this, never
   *  the raw list. */
  readonly messages: ChatMessage[];
  readonly ids: ReadonlySet<string>;
  /** A sent turn still awaiting its reply — what Stop withdraws. */
  readonly pending: ReturnType<typeof pendingTurn>;
  /** Every recorded withdrawal, all stages — the event fold reads them. */
  readonly marks: WithdrawnMark[];
  /** Withdraws the pending turn and hands its body back to the composer via
   *  `restoreDraft` — abort restores the draft, it does not discard it. */
  readonly stop: () => Promise<void>;
};

export function useWithdrawnTurns(
  projectId: string,
  tenantId: string,
  stage: number,
  nodes: readonly ArtifactNode[],
  rawMessages: ChatMessage[],
  restoreDraft: (body: string) => void,
  onError: (message: string) => void,
): WithdrawnTurnsState {
  const withdrawnNode = useMemo(
    () => nodes.find((node) => node.kind === WITHDRAWN_TURNS_KIND) ?? null,
    [nodes],
  );
  const [marks, setMarks] = useState<WithdrawnMark[]>([]);
  useEffect(() => {
    if (!withdrawnNode) {
      setMarks([]);
      return;
    }
    let cancelled = false;
    void api
      .artifactContent(tenantId, withdrawnNode.id)
      .then((result) => {
        if (!cancelled) setMarks(parseWithdrawnTurns(result.content));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [withdrawnNode?.id, tenantId]);

  const ids = useMemo(
    () => new Set(marks.filter((mark) => mark.stage === stage).map((mark) => mark.messageId)),
    [marks, stage],
  );
  const messages = useMemo(() => applyWithdrawn(rawMessages, ids), [rawMessages, ids]);
  const pending = useMemo(() => pendingTurn(messages, ids), [messages, ids]);

  const stop = async () => {
    if (!pending) return;
    const withdrawn = pending;
    restoreDraft(withdrawn.body);
    try {
      await api.withdrawTurn(projectId, tenantId, { messageId: withdrawn.id, stage });
      setMarks((current) => [...current, { messageId: withdrawn.id, stage, at: new Date().toISOString() }]);
    } catch (cause) {
      onError(cause instanceof ApiFailure ? cause.detail.message : String(cause));
    }
  };

  return { messages, ids, pending, marks, stop };
}
