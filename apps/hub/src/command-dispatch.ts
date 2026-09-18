/**
 * Host command dispatch — what remains of it.
 *
 * A person's decision at a gate is not dispatched here. It is a named signal
 * the client delivers to the run over `/hub`; the hub authorizes it by grant,
 * the runtime deduplicates it by `signalId`, `admitGate` admits it inside the
 * run, and the ledger records it on read (`recordAdmittedGates`). `build.fail`
 * is one such signal: the workflow's stage-8 evidence park admits it, same as
 * `build.accept_evidence`. `stage.draft` is client-delivered the same way
 * now (`apps/web/src/run-signal.ts`'s `deliverDraft`); nothing here relays a
 * round any more.
 *
 * The last host-effect commands — `project.archive`, `project.delete`,
 * `stage.select_route`, `stage.retry` — are gone from here too:
 * `project.archive`/`project.delete` route through the client's own installer
 * calls (`apps/web/src/client.ts`'s `updateProject`/`deleteProject`, PR #298),
 * and `stage.select_route`/`stage.retry` (re-entering a stage after a
 * backtrack) have no workflow primitive to land on yet — CL-8461 — so the two
 * UI actions that used them are disabled rather than kept half-wired.
 *
 * Launching a project's lifecycle run is gone too: the client fires it
 * (`apps/web/src/client.ts`'s `createProject`, `@intx/hub-client`'s
 * `triggerWorkflowRun`) right after the installer deploys the lifecycle,
 * same call that used to be `launchProjectRun`/`launchProjectLifecycle`
 * here. All that is left is host principal/authority plumbing the ledger
 * still needs.
 */
import type { Stage } from "@solutions-builder/app/ledger";
import type { Db } from "./db.js";

export { requiredAuthorityFor, soloApprovalFor } from "./command-approvals.js";

/** What a client-delivered gate signal's delivery actually did, so a stored ledger result can tell nothing from broken. */
export type DeliveryOutcome = "delivered" | "no_execution" | "failed";

/**
 * The host's own principal. It holds `system` authority and nothing else, which
 * is what lets the host relay a verified worker request (`build.wait_for_human`)
 * without any human appearing to have made it. It cannot cross a gate: no
 * ledger row that transitions a stage names `system` as an authority.
 */
export const HOST_PRINCIPAL = "p_host";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The shape a client-delivered gate signal's ledger entry carries (`command-ledger.ts`). */
export type CommandOutcome = {
  readonly runId: string;
  readonly stage: Stage;
  readonly state: string;
  readonly transitionId: string;
  readonly replayed: boolean;
  /** Set when the ledger entry came from a client-delivered gate signal. */
  readonly delivery?: DeliveryOutcome;
};
