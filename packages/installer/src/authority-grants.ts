/**
 * Grants derived from the ledger's authorities.
 *
 * There is no lifecycle workflow left to signal (no chat section, no approve
 * chain, no round names): a stage's approval is a client-side artifact
 * write, and a stage specialist's own mail-triggered run is addressed
 * directly, never gated by a signal grant. The one exception is stage 9,
 * whose delivery decision is a stock hub approval on the delivery
 * specialist's own `deliver` tool call (CL-8566) — that grant is minted here.
 *
 * `system` is never minted: the host acts as system, it does not grant it.
 */
import type { Transport } from "@intx/hub-client";
import { LEDGER, type Authority } from "@solutions-builder/app/ledger";
import { DELIVERY_STAGE } from "@solutions-builder/app/specialist-source";
import { ensureRoleGrant } from "./hub.js";

/**
 * Wildcard covering every approval in the tenant: run ids (and anchor run
 * ids) do not exist at install time, so the installer mints `approval:*` and
 * the hub's own `approval:<anchorRunId>` check narrows it per approval
 * (`vendor/interchange/packages/hub-api/src/routes/approvals.ts`).
 */
export const APPROVAL_RESOURCE = "approval:*";

/** Whether this authority ever decides stage 9's delivery, read from the ledger. */
function holdsDeliveryDecision(authority: Authority): boolean {
  return LEDGER.some(
    (row) => row.command.startsWith("delivery.") && (row.stages?.includes(DELIVERY_STAGE) ?? false) && row.authority.includes(authority),
  );
}

/**
 * The `authority:<name>/hold` grant, and — for the project owner and
 * stakeholders the ledger already names on `delivery.accept`/`.reject`/`.revise`
 * — the `approval:*`/`resolve` grant the stock approval routes check. Same
 * call from workspace install and project-tenant install so the two cannot
 * drift.
 */
export async function ensureAuthorityGrants(
  transport: Transport,
  scope: string,
  roleId: string,
  authority: Authority,
): Promise<void> {
  await ensureRoleGrant(transport, scope, {
    roleId,
    resource: `authority:${authority}`,
    action: "hold",
    effect: "allow",
    origin: "role",
  });
  if (holdsDeliveryDecision(authority)) {
    await ensureRoleGrant(transport, scope, {
      roleId,
      resource: APPROVAL_RESOURCE,
      action: "resolve",
      effect: "allow",
      origin: "role",
    });
  }
}
