/**
 * Files one @corbits/mailbox inbox item per principal who may resolve a
 * newly-parked decision — the client-side stand-in for the deleted
 * `apps/hub/src/decisions.ts`'s `notifyDecisionOpen`. Workflow action
 * handlers have no hub transport yet to fire this from a stage-loop step
 * (CL-8489's blocker), so it fires from `decisions-fold.ts`'s
 * `openDecisionFor` instead — the fold that first observes the park — over
 * the mounted `POST /api/me/inbox/send`. `packages/embed-hub`'s own
 * `notifyGrantHolders` is untouched: this is a separate, client-driven path.
 *
 * Recipients are holders of the gate's `signal:<name>` grant (or, for stage
 * 9's stock approval, the `approval:*`/`resolve` grant), resolved through
 * the installer's `grantHolders`. `POST /me/inbox/send` fills `from` from
 * the caller's own session; only `to` needs resolving here.
 *
 * Dedup is a `[decision:<id>]` marker in the sender's own Sent folder, not
 * localStorage: the marker lives in the hub, so a refresh, another tab, or a
 * different principal opening the same project all see the same record and
 * send nothing new for a park that already got one.
 */
import type { Transport } from "@intx/hub-client";
import { APPROVAL_RESOURCE, WORKFLOW_RUN_RESOURCE, grantHolders, signalGrantAction } from "@solutions-builder/installer";
import { approveSignal, evidenceSignal } from "@solutions-builder/app/workflows/stage-loop";
import type { Stage } from "@solutions-builder/app/ledger";
import type { Wait } from "./client.ts";
import { createHubTransport } from "./hub.ts";

export type NotifiableDecision = Omit<Wait, "projectTitle">;

type InboxMessage = { readonly envelope: { readonly subject: string } };
type InboxPage = { readonly messages: readonly InboxMessage[] };

function markerFor(id: string): string {
  return `[decision:${id}]`;
}

/** The kind `decisionIdFor` folded into the id's trailing segment. */
function kindFromId(id: string): "gate" | "freeze" | "evidence" | "question" | "approval" {
  const kind = id.split(":").at(-1);
  return kind === "freeze" || kind === "evidence" || kind === "question" || kind === "approval" ? kind : "gate";
}

/** The `signal:<name>` gate a decision of this kind parks on. */
function gateSignalFor(stage: Stage, kind: ReturnType<typeof kindFromId>): string {
  return kind === "evidence" || kind === "question" ? evidenceSignal(stage) : approveSignal(stage);
}

/**
 * Notifies every principal who may resolve `decision`. Best effort: a
 * mailbox failure never blocks the decision queue from rendering, so a
 * caller fires this without awaiting it in the render path.
 */
export async function notifyDecisionOpen(
  decision: NotifiableDecision,
  transport: Transport = createHubTransport(),
): Promise<void> {
  try {
    const marker = markerFor(decision.id);
    const sent = await transport.fetch<InboxPage>("GET", "/api/me/inbox?folder=Sent&limit=200");
    if (sent.messages.some((message) => message.envelope.subject.includes(marker))) return;

    const kind = kindFromId(decision.id);
    const [resource, action] =
      kind === "approval"
        ? [APPROVAL_RESOURCE, "resolve"]
        : [WORKFLOW_RUN_RESOURCE, signalGrantAction(gateSignalFor(decision.stage as Stage, kind))];
    const holders = await grantHolders(transport, decision.projectId, resource, action);
    if (holders.length === 0) return;

    await transport.fetch("POST", "/api/me/inbox/send", {
      to: holders.map((holder) => holder.address),
      subject: `${marker} ${decision.title}`,
      body: decision.consequence,
    });
  } catch (cause) {
    console.error(`decision notify failed for ${decision.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
