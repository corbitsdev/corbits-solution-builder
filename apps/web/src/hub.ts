/**
 * Hub API over the host's `/hub` mount.
 *
 * The browser never talks to Interchange internals. It uses `@intx/hub-client`'s
 * `Transport` against the same authenticated origin the rest of the UI uses;
 * the host strips `/hub` and dispatches. Same-origin credentials carry the
 * browser's own cookies, including any hub session the hub set. The mount
 * does not swap in an owner session.
 */
import { ApiError, type Transport } from "@intx/hub-client";

export type { Transport };
export { ApiError };

/**
 * A transport that prefixes every path with `/hub` and sends the session
 * cookie. The installer package and the run fold/signal modules are driven
 * by this, not by a second client of the hub.
 */
export function createHubTransport(): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        const init: RequestInit = { method, credentials: "same-origin" };
        if (body !== undefined) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(body);
        }
        response = await fetch(`/hub${path}`, init);
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
      const source = new EventSource(`/hub${path}`);
      const handler = (event: MessageEvent) => {
        onEvent(JSON.parse(event.data));
      };
      if (opts?.eventName) source.addEventListener(opts.eventName, handler);
      else source.onmessage = handler;
      return () => source.close();
    },
  };
}
