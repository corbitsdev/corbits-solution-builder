/**
 * Deliver a signal to a project's lifecycle run over `/hub`.
 *
 * This is the run, not the ledger. Gate commands that move the ledger still
 * go through the host (`POST /commands`, `/submit`, `/decide`); those routes
 * write the command and the host delivers the matching signal. Calling this
 * from the same click as a host command would dual-write. Use it when the
 * browser is talking to the run itself.
 */
import { deliverWorkflowSignal, type Transport } from "@intx/hub-client";
import { createHubTransport } from "./hub.ts";

export async function signalRun(
  args: {
    readonly tenantId: string;
    readonly anchorRunId: string;
    readonly signalName: string;
    readonly signalId: string;
    readonly payload?: unknown;
  },
  transport: Transport = createHubTransport(),
): Promise<void> {
  await deliverWorkflowSignal(transport, args.tenantId, args.anchorRunId, {
    runId: args.anchorRunId,
    signalName: args.signalName,
    signalId: args.signalId,
    ...(args.payload !== undefined ? { payload: args.payload } : {}),
  });
}
