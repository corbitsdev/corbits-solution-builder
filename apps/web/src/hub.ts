/**
 * Hub API on the hub's own origin.
 *
 * The browser never talks to Interchange internals through the host. It
 * uses `@intx/hub-client`'s `Transport` straight against the hub's own paths
 * (`/api/tenants/...`, `/api/me`, `/api/auth/...`), with no `/hub` prefix and
 * no relay in between — embedded, the host mounts the hub on this same
 * origin; remote (`SOLUTIONS_BUILDER_HUB_URL`), `hubOrigin()` names the
 * hub's own origin and every call goes there directly. Either way the
 * browser's own cookies carry the session, never a host-swapped one.
 */
import { ApiError, type Transport } from "@intx/hub-client";
import { hubCredentials, hubEventSourceCredentials, hubOrigin } from "./hub-origin.ts";
import { openSharedEventSource } from "./shared-event-source.ts";

export type { Transport };
export { ApiError };

/**
 * A transport that calls the hub's own paths and sends the session cookie.
 * The installer package and the run fold/signal modules are driven by this,
 * not by a second client of the hub.
 */
/** Longer than any healthy call, including a build's packaging and a workflow's deploy-and-wait (#746). */
export const HUB_REQUEST_CEILING_MS = 5 * 60_000;

/** The last few request durations (#777): what the window reads to say the host is slow. */
const LATENCY_SAMPLES = 8;
const latencies: number[] = [];

function recordLatency(ms: number): void {
  latencies.push(ms);
  if (latencies.length > LATENCY_SAMPLES) latencies.shift();
}

/** The average duration of the host's recent requests, and how many were measured. */
export function hostLatency(): { averageMs: number; samples: number } {
  if (latencies.length === 0) return { averageMs: 0, samples: 0 };
  return { averageMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length, samples: latencies.length };
}

/** For tests: forget every measurement. */
export function resetHostLatency(): void {
  latencies.length = 0;
}

export function createHubTransport(): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        // A ceiling on every request (#746): a hung connection frees
        // itself and is said as such, rather than holding one of the
        // browser's few connections to the host forever.
        const init: RequestInit = { method, credentials: hubCredentials(), signal: AbortSignal.timeout(HUB_REQUEST_CEILING_MS) };
        if (body !== undefined) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(body);
        }
        const startedAt = Date.now();
        response = await fetch(`${hubOrigin()}${path}`, init);
        recordLatency(Date.now() - startedAt);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "TimeoutError") {
          throw new ApiError(0, "host_timeout", "The host did not answer in time. Try again; if it keeps happening, restart the host.");
        }
        throw new ApiError(
          0,
          "host_unreachable",
          "That request did not reach the host. Try again, or reopen the window.",
        );
      }

      if (response.status === 204) return undefined as T;
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        const detail = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new ApiError(
          response.status,
          detail?.code ?? "unknown",
          detail?.message ?? `HTTP ${response.status}`,
        );
      }
      return parsed as T;
    },
    subscribe(path: string, onEvent: (event: unknown) => void, opts?: { eventName?: string }): () => void {
      const source = openSharedEventSource(`${hubOrigin()}${path}`, hubEventSourceCredentials());
      const handler = (event: { data: string }) => {
        onEvent(JSON.parse(event.data));
      };
      source.addEventListener(opts?.eventName ?? "message", handler);
      return () => source.close();
    },
  };
}
