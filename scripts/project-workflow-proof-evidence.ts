export type ProofEvent = { seq?: number; type: string; body: Record<string, unknown> };

export function assertParked(events: ProofEvent[], stepId: string): void {
  if (!events.some((event) => event.type === "SignalAwaited" && event.body.stepId === stepId)) {
    throw new Error(`project workflow did not park on ${stepId}; fault injection refused`);
  }
  if (events.some((event) => event.type === "RunCompleted" || event.type === "RunFailed")) {
    throw new Error("project workflow is terminal; fault injection refused");
  }
  if (events.some((event) => event.type === "StepCompleted" && event.body.stepId === stepId)) {
    throw new Error("project workflow already left the wait; fault injection refused");
  }
}

export function stepExecutionCounts(events: ProofEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "StepStarted") continue;
    const stepId = typeof event.body.stepId === "string" ? event.body.stepId : "?";
    counts[stepId] = (counts[stepId] ?? 0) + 1;
  }
  return counts;
}

/**
 * No step that already committed before a fault re-executes after the fault:
 * every step present in `before`'s execution counts keeps the exact same
 * count in `after` (counts only grow for steps still in flight, never for
 * ones already completed pre-fault).
 */
export function assertNoReplay(before: ProofEvent[], after: ProofEvent[], settledStepIds: readonly string[]): void {
  const beforeCounts = stepExecutionCounts(before);
  const afterCounts = stepExecutionCounts(after);
  for (const stepId of settledStepIds) {
    if ((beforeCounts[stepId] ?? 0) !== (afterCounts[stepId] ?? 0)) {
      throw new Error(`step ${stepId} replayed after fault (before=${String(beforeCounts[stepId])}, after=${String(afterCounts[stepId])})`);
    }
  }
}

// Allowlist, not redaction: arbitrary runtime text/payloads may contain credentials.
export function logSummary(line: string): { bytes: number; categories: string[] } {
  const categories = ["reconcil", "connect", "dispatch", "signal", "error", "warn", "launch URL"];
  return { bytes: Buffer.byteLength(line), categories: categories.filter((word) => line.toLowerCase().includes(word.toLowerCase())) };
}

export function eventSummary(events: ProofEvent[]): unknown[] {
  return events.map(({ seq, type, body }) => ({ type, seq, at: body.at, stepId: body.stepId, signalName: body.signalName, signalId: body.signalId }));
}

export function runCompletedCount(events: ProofEvent[]): number {
  return events.filter((event) => event.type === "RunCompleted").length;
}
