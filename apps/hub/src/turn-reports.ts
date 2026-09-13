/**
 * A worker's own account of each turn, as it happens.
 *
 * A coding agent spends most of a long build calling tools and says little
 * between them, so its stdout goes quiet for hours while it works. Workers
 * that offer a lifecycle hook can report every turn — the tool calls it made
 * and how they went — into a log the bridge places for it. This module
 * follows that log while the worker runs and says each turn in a line or
 * two, for the live pane.
 *
 * What is said is what the worker reported, in the worker's own terms: the
 * tool's name, its arguments, whether it errored. Nothing here infers
 * progress, stage or success from it — the report is the worker's, the
 * verdict on the build is still a person's.
 */
import { open, stat } from "node:fs/promises";

/** The shape a turn report is read as; anything else is shown as unreadable. */
type TurnReport = {
  turnIndex?: number;
  durationMs?: number;
  toolCalls?: { id?: string; name?: string; arguments?: unknown }[];
  toolResults?: { callId?: string; content?: unknown; isError?: boolean }[];
};

const ARGUMENTS_KEEP = 200;
const ERROR_KEEP = 160;

/** One turn, said in a header line and one line per tool call. */
export function describeTurn(record: unknown): string {
  const report = (record ?? {}) as TurnReport;
  const calls = Array.isArray(report.toolCalls) ? report.toolCalls : [];
  const results = new Map(
    (Array.isArray(report.toolResults) ? report.toolResults : []).map((result) => [result.callId, result] as const),
  );
  const turn = typeof report.turnIndex === "number" ? report.turnIndex + 1 : "?";
  const took = typeof report.durationMs === "number" ? ` · ${(report.durationMs / 1000).toFixed(1)}s` : "";
  const count = `${calls.length} tool call${calls.length === 1 ? "" : "s"}`;
  const lines = [`── turn ${turn} · ${count}${took}`];
  for (const call of calls) {
    const result = call.id ? results.get(call.id) : undefined;
    const outcome =
      result?.isError === true ? ` → error: ${firstLine(result.content).slice(0, ERROR_KEEP)}` : "";
    lines.push(`   ${call.name ?? "(unnamed tool)"} ${compact(call.arguments)}${outcome}`);
  }
  return `${lines.join("\n")}\n`;
}

function compact(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    text = "(arguments not shown)";
  }
  return text.length > ARGUMENTS_KEEP ? `${text.slice(0, ARGUMENTS_KEEP)}…` : text;
}

function firstLine(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

export type TurnTally = { turns: number; toolCalls: number };

/**
 * Follows a JSON-lines log as it grows, saying each complete record as it
 * lands. Polled rather than watched: a file that is appended to by a hook
 * process is exactly what file watching gets wrong on macOS. `stop` reads
 * whatever landed last and resolves with how much was reported.
 */
export function followTurnLog(
  path: string,
  onTurn: (text: string) => void,
  intervalMs = 500,
): { stop: () => Promise<TurnTally> } {
  let offset = 0;
  let partial = "";
  const tally: TurnTally = { turns: 0, toolCalls: 0 };
  let reading: Promise<void> = Promise.resolve();

  const readNew = async () => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;
      partial += buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        onTurn("── a turn report the bridge could not read\n");
        continue;
      }
      tally.turns += 1;
      const calls = (record as TurnReport).toolCalls;
      tally.toolCalls += Array.isArray(calls) ? calls.length : 0;
      onTurn(describeTurn(record));
    }
  };

  const tick = () => {
    reading = reading.then(readNew).catch(() => undefined);
  };
  const timer = setInterval(tick, intervalMs);

  return {
    stop: async () => {
      clearInterval(timer);
      tick();
      await reading;
      return tally;
    },
  };
}
