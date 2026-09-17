/**
 * Boot must create the workspace tenant before the host listens.
 *
 * The `/hub` proxy refuses unscoped `POST /api/tenants` — creating a root
 * tenant is a host-only act, via `ensureWorkspaceOnce`. If that call is
 * swallowed and the host still serves, the client install hits 403 and only
 * a restart recovers (CL-8138). Retry the in-process ensure; if it never
 * succeeds, throw so `Bun.serve` is never reached.
 */

export type RetryEnsureOptions = {
  /** Tries including the first. Exhaustion throws rather than listening. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onFailure?: (cause: unknown, attempt: number) => void;
};

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 250;

export async function retryEnsureWorkspace(
  ensure: () => Promise<void>,
  options: RetryEnsureOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (attempts < 1) throw new Error("retryEnsureWorkspace requires at least one attempt.");

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ensure();
      return;
    } catch (cause) {
      last = cause;
      options.onFailure?.(cause, attempt);
      if (attempt === attempts) break;
      await sleep(delayMs);
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new Error(
    `Could not ensure the workspace tenant after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${detail}. The host will not listen until the workspace exists.`,
    last instanceof Error ? { cause: last } : undefined,
  );
}
