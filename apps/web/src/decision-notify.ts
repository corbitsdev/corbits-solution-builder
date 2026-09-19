/**
 * Files one @corbits/mailbox inbox item per principal who may resolve a
 * newly-parked decision — the client-side stand-in for the deleted
 * `apps/hub/src/decisions.ts`'s `notifyDecisionOpen`. Workflow action
 * handlers have no hub transport to fire this from, so it fires from
 * `decisions-fold.ts`'s `openDecisionFor` instead — the fold that first
 * observes the park — over the tenant-scoped mailbox mount (the same one
 * `stage-mail.ts` uses), never the legacy un-scoped `/api/me/inbox*`.
 * `packages/embed-hub`'s own `notifyGrantHolders` is untouched: this is a
 * separate, client-driven path.
 *
 * CL-8657: the un-scoped mount's `resolvePrincipal` matches the caller's own
 * session against ANY `principal` row for that user with no tenant filter
 * (`LIMIT 1`, arbitrary), so the minted sender address can land on a tenant
 * that has nothing to do with the project being notified about. `@corbits/
 * mailbox`'s send route (`mount.js`) then calls `buildMailFrame`, which runs
 * the minted Message-ID through `assertMsgId` with no try/catch around it —
 * a malformed/empty domain throws `RangeError` there, uncaught, which Hono
 * turns into an unhandled 500. The tenant-scoped mount resolves the caller's
 * principal from the URL's own `tenantId` instead, so the sender is always
 * addressed in the same tenant this call already trusts.
 *
 * CL-8612 contract v6: the only decision left is stage 9's stock hub
 * approval on the specialist's own `deliver` tool call (CL-8566) — no
 * lifecycle run, no `signal:<name>` gate grant any more. Recipients are
 * holders of the `approval:*`/`resolve` grant, resolved through the
 * installer's `grantHolders`. `POST .../mailbox/me/inbox/send` fills `from`
 * from the caller's own session; only `to` needs resolving here.
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

const ADDRESS = /^[^\s@]+@[^\s@]+$/;

function markerFor(id: string): string {
  return `[decision:${id}]`;
}

function mailboxPath(tenantId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/mailbox/me/inbox`;
}

/**
 * Notifies every principal who may resolve `decision`. Best effort: a
 * mailbox failure never blocks the decision queue from rendering, so a
 * caller fires this without awaiting it in the render path.
 *
 * `workspaceTenantId` is the workspace's own tenant (`resolveWorkspace`'s
 * `tenantId`, as `decisions-fold.ts` already resolves it) — the sender is
 * always addressed there, never in the project's own tenant that
 * `grantHolders` below reads recipients from.
 */
export async function notifyDecisionOpen(
  workspaceTenantId: string,
  decision: NotifiableDecision,
  transport: Transport = createHubTransport(),
): Promise<void> {
  try {
    const path = mailboxPath(workspaceTenantId);
    const marker = markerFor(decision.id);
    const sent = await transport.fetch<InboxPage>("GET", `${path}?folder=Sent&limit=200`);
    if (sent.messages.some((message) => message.envelope.subject.includes(marker))) return;

    const holders = await grantHolders(transport, decision.projectId, APPROVAL_RESOURCE, "resolve");
    const to = holders.map((holder) => holder.address).filter((address) => ADDRESS.test(address));
    if (to.length === 0) return;

    await transport.fetch("POST", `${path}/send`, {
      to,
      subject: `${marker} ${decision.title}`,
      body: decision.consequence,
    });
  } catch (cause) {
    console.error(`decision notify failed for ${decision.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
