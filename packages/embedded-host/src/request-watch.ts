/**
 * What the host says about its own health (#762): slow requests as they
 * finish, a resource line once a minute, and a warning the moment the event
 * loop stalls. Twice the host pinned a CPU for minutes with a log that said
 * nothing; these lines name the request and the moment.
 */

export const SLOW_REQUEST_MS = 2_000;
export const RESOURCE_LINE_EVERY_MS = 60_000;
export const LAG_WARN_MS = 1_000;

type InFlight = { readonly id: number; readonly method: string; readonly path: string; readonly startedAt: number };

const inFlight = new Map<number, InFlight>();
let nextId = 1;
let lastResourceLineAt: number | null = null;

export type Log = (line: string) => void;

/** Marks a request as in flight; `endRequest` with the id closes it. */
export function beginRequest(method: string, path: string, now = Date.now()): number {
  const id = nextId++;
  inFlight.set(id, { id, method, path, startedAt: now });
  return id;
}

/** Closes a request; a slow one is said, with what else was in flight while it ran. */
export function endRequest(id: number, status: number | "failed", log: Log, now = Date.now()): void {
  const entry = inFlight.get(id);
  inFlight.delete(id);
  if (!entry) return;
  const took = now - entry.startedAt;
  if (took < SLOW_REQUEST_MS) return;
  const others = inFlight.size;
  log(`Slow request: ${entry.method} ${entry.path} took ${seconds(took)} (${String(status)})${others > 0 ? `; ${String(others)} other request${others === 1 ? "" : "s"} in flight` : ""}`);
}

/** The requests in flight, oldest first. */
export function inFlightRequests(now = Date.now()): { method: string; path: string; ageMs: number }[] {
  return [...inFlight.values()].sort((a, b) => a.startedAt - b.startedAt).map((entry) => ({ method: entry.method, path: entry.path, ageMs: now - entry.startedAt }));
}

export type ResourceSample = {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  /** How late the heartbeat tick ran: time the event loop could not get to it. */
  readonly lagMs: number;
  readonly inFlight: readonly { method: string; path: string; ageMs: number }[];
};

/** One line a person can read at a glance; the same shape every time, so a log can be grepped. */
export function resourceLine(sample: ResourceSample): string {
  const oldest = sample.inFlight[0];
  return [
    `Host resources: rss ${megabytes(sample.rssBytes)}, heap ${megabytes(sample.heapUsedBytes)}, loop lag ${String(sample.lagMs)}ms`,
    `${String(sample.inFlight.length)} request${sample.inFlight.length === 1 ? "" : "s"} in flight`,
    oldest ? `oldest ${oldest.method} ${oldest.path} for ${seconds(oldest.ageMs)}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
}

/**
 * Called on every heartbeat tick with how late it ran. A stall is said at
 * once with what was in flight, and a resource line goes out once a minute.
 */
export function observeTick(lagMs: number, log: Log, now = Date.now(), usage: () => { rss: number; heapUsed: number } = () => process.memoryUsage()): void {
  const flights = inFlightRequests(now);
  if (lagMs >= LAG_WARN_MS) {
    const named = flights.slice(0, 5).map((entry) => `${entry.method} ${entry.path} (${seconds(entry.ageMs)})`).join(", ");
    log(`Event loop stalled for ${seconds(lagMs)}${flights.length > 0 ? `; in flight: ${named}${flights.length > 5 ? `, and ${String(flights.length - 5)} more` : ""}` : ""}`);
  }
  if (lastResourceLineAt === null || now - lastResourceLineAt >= RESOURCE_LINE_EVERY_MS) {
    lastResourceLineAt = now;
    const memory = usage();
    log(resourceLine({ rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, lagMs, inFlight: flights }));
  }
}

/** For tests: forget every flight and the last resource line. */
export function resetRequestWatch(): void {
  inFlight.clear();
  nextId = 1;
  lastResourceLineAt = null;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}
