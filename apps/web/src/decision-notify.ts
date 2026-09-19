/**
 * Files one @corbits/mailbox inbox item per principal who may resolve a
 * newly-parked decision — the client-side stand-in for the deleted
 * `apps/hub/src/decisions.ts`'s `notifyDecisionOpen`. Workflow action
 * handlers have no hub transport to fire this from, so it fires from
 * `decisions-fold.ts`'s `openDecisionFor` instead — the fold that first
 * observes the park — over the mounted `POST /api/me/inbox/send`.
 * `packages/embed-hub`'s own `notifyGrantHolders` is untouched: this is a
 * separate, client-driven path.
 *
 * CL-8612 contract v6: the only decision left is stage 9's stock hub
 * approval on the specialist's own `deliver` tool call (CL-8566) — no
 * lifecycle run, no `signal:<name>` gate grant any more. Recipients are
 * holders of the `approval:*`/`resolve` grant, resolved through the
 * installer's `grantHolders`. `POST /me/inbox/send` fills `from` from the
 * caller's own session; only `to` needs resolving here.
 *
 * Dedup is a `[decision:<id>]` marker in the sender's own Sent folder, not
 * localStorage: the marker lives in the hub, so a refresh, another tab, or a
 * different principal opening the same project all see the same record and
 * send nothing new for a park that already got one.
 */
import type { Transport } from "@intx/hub-client";
import { APPROVAL_RESOURCE, grantHolders } from "@solutions-builder/installer";
import type { Wait } from "./client.ts";
import { createHubTransport } from "./hub.ts";

export type NotifiableDecision = Omit<Wait, "projectTitle">;

type InboxMessage = { readonly envelope: { readonly subject: string } };
type InboxPage = { readonly messages: readonly InboxMessage[] };

function markerFor(id: string): string {
  return `[decision:${id}]`;
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

    const holders = await grantHolders(transport, decision.projectId, APPROVAL_RESOURCE, "resolve");
    if (holders.length === 0) return;

    // CL-8605: this body carries no messageId/inReplyTo/references — the
    // route mints its own Message-ID from the session's resolved sender
    // address (`@corbits/mailbox`'s `/me/inbox/send`, via
    // `packages/embed-hub`'s `principalAddress`), never from anything sent
    // here. A malformed tenant domain can still make that minted id fail the
    // route's own `assertMsgId` and 500 uncaught; the catch below is the only
    // guard this call can offer against that.
    await transport.fetch("POST", "/api/me/inbox/send", {
      to: holders.map((holder) => holder.address),
      subject: `${marker} ${decision.title}`,
      body: decision.consequence,
    });
  } catch (cause) {
    console.error(`decision notify failed for ${decision.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
