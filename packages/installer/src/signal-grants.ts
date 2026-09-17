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
 * `system` is never minted: the host acts as system, it does not grant it.
 */
import type { Transport } from "@intx/hub-client";
import { LEDGER, STAGES, type Authority, type Command } from "@solutions-builder/app/ledger";
import { stageSignal } from "@solutions-builder/app/workflows/stage-loop";
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

/**
 * The awaiter names a human authority may deliver, read from the ledger.
 * Empty for `system`. A command with no `from` never becomes a run signal
 * (`project.create` opens the project; it does not park a step).
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
 * The `authority:<name>/hold` grant plus every named-signal grant that name
 * may deliver. Same call from workspace install and project-tenant install so
 * the two cannot drift.
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
}
