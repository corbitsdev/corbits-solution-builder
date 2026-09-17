/**
 * The workflow gate's admit step — the ledger guard, called from the run.
 *
 * A stage's approval loop waits for a signal, then this handler. The host
 * delivers the command; this is what admits or refuses it. A refusal is the
 * step's output, not a host run mutation: the loop runs again and waits.
 */
import { evaluate, type GuardContext, type RunView } from "./guard.js";
import { foldRun, projectState, type RunEvent } from "./project-state.js";
import type { Command, Stage, Transition } from "./ledger.js";
import type { RefusalCode } from "./guard.js";

export type AdmitSignal = {
  readonly command: Command;
  readonly run: RunView;
  readonly context: GuardContext;
};

export type AdmitVerdict =
  | { readonly refused: false; readonly transition: Transition; readonly toStage: Stage }
  | { readonly refused: true; readonly code: RefusalCode; readonly message: string };

function asCommand(value: unknown): Command | null {
  return typeof value === "string" && value.length > 0 ? (value as Command) : null;
}

function asRunView(value: unknown): RunView | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.kind !== "string") return null;
  if (typeof rec.stage !== "number" || typeof rec.state !== "string") return null;
  if (typeof rec.originId !== "string") return null;
  return rec as unknown as RunView;
}

function asContext(value: unknown): GuardContext {
  if (!value || typeof value !== "object") return { actorAuthorities: [] };
  const rec = value as Record<string, unknown>;
  const authorities = rec.actorAuthorities;
  return {
    actorAuthorities: Array.isArray(authorities)
      ? authorities.filter((entry): entry is GuardContext["actorAuthorities"][number] => typeof entry === "string")
      : [],
    ...(typeof rec.targetStage === "number" ? { targetStage: rec.targetStage as Stage } : {}),
    ...(typeof rec.frozenPacketExists === "boolean" ? { frozenPacketExists: rec.frozenPacketExists } : {}),
    ...(typeof rec.waitingRequestOriginId === "string" ? { waitingRequestOriginId: rec.waitingRequestOriginId } : {}),
    ...(typeof rec.checkpointResumeVerified === "boolean"
      ? { checkpointResumeVerified: rec.checkpointResumeVerified }
      : {}),
    ...(typeof rec.versionHashesMatch === "boolean" ? { versionHashesMatch: rec.versionHashesMatch } : {}),
    ...(rec.audience && typeof rec.audience === "object" ? { audience: rec.audience as GuardContext["audience"] } : {}),
  };
}

function asEvents(value: unknown): RunEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is RunEvent => {
    if (!entry || typeof entry !== "object") return false;
    const rec = entry as Record<string, unknown>;
    return typeof rec.seq === "number" && typeof rec.type === "string" && rec.body !== null && typeof rec.body === "object";
  });
}

/**
 * Admit a gate signal against the ledger. `events` are the run's own committed
 * workflow events; `signal` carries the command and the run the host folded.
 * A parked stage that disagrees with that run is a stale delivery.
 */
export function admit(events: readonly RunEvent[], signal: AdmitSignal): AdmitVerdict {
  if (events.length > 0) {
    const parked = projectState([foldRun(signal.run.id, events)]);
    if (parked && parked.stage !== signal.run.stage) {
      return {
        refused: true,
        code: "wrong_state",
        message: `The run is parked at stage ${parked.stage}, not ${signal.run.stage}.`,
      };
    }
  }
  const verdict = evaluate(signal.command, signal.run, signal.context);
  if (!verdict.ok) return { refused: true, code: verdict.code, message: verdict.message };
  return { refused: false, transition: verdict.transition, toStage: verdict.toStage };
}

/**
 * The `interchange.actions` export the gate loop names. Input is the awaiter's
 * signal payload: command, run, guard context, and any events the host attached.
 */
export async function admitGate(input: unknown): Promise<AdmitVerdict> {
  if (!input || typeof input !== "object") {
    return { refused: true, code: "unknown_command", message: "The gate signal carried no payload." };
  }
  const rec = input as Record<string, unknown>;
  const command = asCommand(rec.command);
  const run = asRunView(rec.run);
  if (!command || !run) {
    return {
      refused: true,
      code: "unknown_command",
      message: "The gate signal did not name a command and a run.",
    };
  }
  return admit(asEvents(rec.events), { command, run, context: asContext(rec.context ?? rec) });
}
