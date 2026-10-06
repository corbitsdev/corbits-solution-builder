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
import { readFile } from "node:fs/promises";
import { followFile } from "./file-follow.js";

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

/** Counts one record into the tally, and says it. */
function takeRecord(line: string, tally: TurnTally, onTurn: (text: string) => void): void {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    onTurn("── a turn report the bridge could not read\n");
    return;
  }
  tally.turns += 1;
  const calls = (record as TurnReport).toolCalls;
  tally.toolCalls += Array.isArray(calls) ? calls.length : 0;
  onTurn(describeTurn(record));
}

/**
 * Follows a JSON-lines log as it grows, saying each complete record as it
 * lands. `stop` reads whatever landed last and resolves with how much was
 * reported. From the end, records already there are counted but not said
 * again: a host that starts and finds the worker still running.
 */
export function followTurnLog(
  path: string,
  onTurn: (text: string) => void,
  intervalMs = 500,
  from: "start" | "end" = "start",
): { stop: () => Promise<TurnTally> } {
  let partial = "";
  const tally: TurnTally = { turns: 0, toolCalls: 0 };
  const counted = from === "end" ? tallyTurnLog(path) : Promise.resolve({ turns: 0, toolCalls: 0 });
  const follower = followFile(
    path,
    (text) => {
      partial += text;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim().length > 0) takeRecord(line, tally, onTurn);
    },
    { intervalMs, from },
  );
  return {
    stop: async () => {
      await follower.stop();
      const before = await counted;
      return { turns: before.turns + tally.turns, toolCalls: before.toolCalls + tally.toolCalls };
    },
  };
}

/** How many turns and tool calls a whole log reports; zero for a log that is not there. */
export async function tallyTurnLog(path: string): Promise<TurnTally> {
  const tally: TurnTally = { turns: 0, toolCalls: 0 };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return tally;
  }
  for (const line of text.split("\n")) if (line.trim().length > 0) takeRecord(line, tally, () => undefined);
  return tally;
}
