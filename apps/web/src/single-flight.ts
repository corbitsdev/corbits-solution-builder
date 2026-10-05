/**
 * Two small guards against a slow host taking the window with it (#746).
 *
 * A poll that fires on a timer must never stack: a read still outstanding
 * is reused by the next tick, so a hung endpoint costs one connection, not
 * one per tick until the browser's per-origin limit stalls every request.
 * And a busy flag held for a read must let go after a bound, even if the
 * read has not returned; the read's own result still lands when it does.
 */

/** Wraps an async function so concurrent calls share the one in-flight promise. */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const call = run().finally(() => {
      pending = null;
    });
    pending = call;
    return call;
  };
}

/** Resolves when `work` does, or after `limitMs`, whichever is first; `work` is not cancelled. */
export function withinBound<T>(work: Promise<T>, limitMs: number, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<"done" | "timed_out"> {
  return Promise.race([work.then(() => "done" as const, () => "done" as const), wait(limitMs).then(() => "timed_out" as const)]);
}
