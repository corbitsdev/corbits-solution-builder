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
export function createHubTransport(): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        const init: RequestInit = { method, credentials: hubCredentials() };
        if (body !== undefined) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(body);
        }
        response = await fetch(`${hubOrigin()}${path}`, init);
      } catch {
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
