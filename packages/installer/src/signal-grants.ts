/**
 * Named-signal grants derived from the ledger.
 *
 * The hub signal route authorizes `POST /:runId/signals` with `signal:<signalName>` on
 * `workflow-run:<runId>` (or `manage` as a superset). Run ids do not exist at
 * install time, so the installer mints the matching wildcard: `workflow-run:*`
 * with action `signal:<awaiter>`. The awaiter names are the ones
 * `stageSignal` already produces from the ledger — a round command lands on
 * that stage's round, everything else on its gate — so a role that cannot
 * issue a command never receives the grant for the signal that command would
 * send.
 *
 * Stage 9 is the one exception: its gate is a stock hub approval on the
 * delivery specialist's own `deliver` tool call (CL-8566), not a named
 * signal, so `approveSignal`/`exhaustedSignal` at stage 9 are excluded here
 * and `ensureAuthorityGrants` mints the approval-resolve grant instead.
 *
 * `system` is never minted: the host acts as system, it does not grant it.
 */
import type { Transport } from "@intx/hub-client";
import { LEDGER, STAGES, type Authority, type Command } from "@solutions-builder/app/ledger";
import { approveSignal, DELIVERY_STAGE, exhaustedSignal, stageSignal } from "@solutions-builder/app/workflows/stage-loop";
import { ensureRoleGrant } from "./hub.js";

/** Wildcard covering every run in the tenant; the route matches it to a run id. */
export const WORKFLOW_RUN_RESOURCE = "workflow-run:*";

export type SignalGrant = {
  readonly resource: typeof WORKFLOW_RUN_RESOURCE;
  readonly action: `signal:${string}`;
};

export function signalGrantAction(signalName: string): `signal:${string}` {
  return `signal:${signalName}`;
}

/** The two stage-9 gate signals the deployed workflow no longer waits on. */
const NO_LONGER_SIGNALED = new Set<string>([approveSignal(DELIVERY_STAGE), exhaustedSignal(DELIVERY_STAGE)]);

/**
 * The awaiter names a human authority may deliver, read from the ledger.
 * Empty for `system`. A command with no `from` never becomes a run signal
 * (`project.create` opens the project; it does not park a step). Stage 9's
 * gate signals are excluded: the deployed workflow has no step waiting on
 * them any more (see the module doc).
 */
export function signalNamesFor(authority: Authority): readonly string[] {
  if (authority === "system") return [];
  const names = new Set<string>();
  for (const row of LEDGER) {
    if (!row.authority.includes(authority) || row.from === null) continue;
    const stages = row.stages ?? STAGES;
    for (const stage of stages) {
      names.add(stageSignal(stage, row.command, "gate").name);
      names.add(stageSignal(stage, row.command, "exhausted").name);
    }
  }
  for (const name of NO_LONGER_SIGNALED) names.delete(name);
  return [...names].sort();
}

/** `workflow-run:*` / `signal:<name>` pairs for one authority role. */
export function signalGrantsFor(authority: Authority): readonly SignalGrant[] {
  return signalNamesFor(authority).map((name) => ({
    resource: WORKFLOW_RUN_RESOURCE,
    action: signalGrantAction(name),
  }));
}

/** Whether this authority is on any ledger row for `command`. */
export function authorityHoldsCommand(authority: Authority, command: Command): boolean {
  return LEDGER.some((row) => row.command === command && row.authority.includes(authority));
}

/**
 * Wildcard covering every approval in the tenant, mirroring
 * `WORKFLOW_RUN_RESOURCE`: run ids (and here, anchor run ids) do not exist at
 * install time, so the installer mints `approval:*` and the hub's own
 * `approval:<anchorRunId>` check narrows it per approval
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
 * The `authority:<name>/hold` grant, every named-signal grant that name may
 * deliver, and — for the project owner and stakeholders the ledger already
 * names on `delivery.accept`/`.reject`/`.revise` — the `approval:*`/`resolve`
 * grant the stock approval routes check. Same call from workspace install
 * and project-tenant install so the two cannot drift.
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
  for (const grant of signalGrantsFor(authority)) {
    await ensureRoleGrant(transport, scope, {
      roleId,
      resource: grant.resource,
      action: grant.action,
      effect: "allow",
      origin: "role",
    });
  }
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
