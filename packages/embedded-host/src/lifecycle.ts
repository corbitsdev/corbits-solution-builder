/**
 * Host lifecycle — BUILD_PLAN_V3 section 3, PRD section 5.
 *
 * The distinction this module exists to keep honest: closing the window
 * disconnects a client. Stopping the host is a separate, explicit act. The
 * tray reflects host state; it is not the source of it.
 *
 * The host also does not claim to run while the machine is asleep. `sleeping`
 * is inferred from a wall-clock gap in its own heartbeat, so the status can say
 * "the host was asleep between X and Y" rather than implying continuous work.
 */
export type HostState = "starting" | "ready" | "stopped";

const HEARTBEAT_MS = 5_000;
/** A gap larger than this means the process was not scheduled — sleep or suspend. */
const SLEEP_THRESHOLD_MS = 60_000;

type Status = {
  state: HostState;
  startedAt: string;
  pid: number;
  connectedClients: number;
  lastHeartbeat: string;
  /** Gaps the host actually observed. Empty means it ran continuously. */
  sleepGaps: { from: string; to: string; seconds: number }[];
};

const status: Status = {
  state: "starting",
  startedAt: new Date().toISOString(),
  pid: process.pid,
  connectedClients: 0,
  lastHeartbeat: new Date().toISOString(),
  sleepGaps: [],
};

let heartbeat: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(): void {
  let previous = Date.now();
  heartbeat = setInterval(() => {
    const now = Date.now();
    const gap = now - previous;
    if (gap > SLEEP_THRESHOLD_MS) {
      status.sleepGaps.push({
        from: new Date(previous).toISOString(),
        to: new Date(now).toISOString(),
        seconds: Math.round(gap / 1000),
      });
    }
    previous = now;
    status.lastHeartbeat = new Date(now).toISOString();
  }, HEARTBEAT_MS);
  // The heartbeat must never be the reason the process stays alive.
  heartbeat.unref?.();
}

export function markReady(): void {
  status.state = "ready";
}

export function clientConnected(): void {
  status.connectedClients += 1;
}

export function hostStatus(): Status & { windowlessWorkContinues: true } {
  return { ...status, windowlessWorkContinues: true };
}

export function markStopped(): void {
  status.state = "stopped";
}
