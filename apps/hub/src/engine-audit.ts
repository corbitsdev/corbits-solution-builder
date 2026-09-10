/**
 * Audit and outbox emission for a committed transition. Nothing here decides
 * whether a transition is allowed — the guard already owns that — and nothing
 * here writes run state.
 */
import { newId } from "./ids.js";
import * as table from "./schema.js";
import type { Tx } from "./engine.js";

export async function audit(
  tx: Tx,
  entry: {
    projectId: string | null;
    actorPrincipalId: string;
    authority: string | null;
    command: string;
    transitionId: string | null;
    correlationId: string;
    before: unknown;
    after: unknown;
    outcome: string;
  },
) {
  await tx.insert(table.auditEvent).values({ id: newId.audit(), ...entry });
}

export async function enqueue(
  tx: Tx,
  topic: string,
  payload: Record<string, unknown>,
  correlationId: string,
) {
  await tx
    .insert(table.outboxEntry)
    .values({ id: newId.outbox(), topic, payload, correlationId });
}
