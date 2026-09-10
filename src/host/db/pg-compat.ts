/**
 * Result-shape adapter between pglite's drizzle handle and packages written
 * against postgres.js.
 *
 * Found by the Gate 2 adoption test: drizzle's `postgres-js` driver resolves
 * `db.execute()` to a row *array*, while the `pglite` driver resolves it to a
 * `{ rows, fields, affectedRows }` object. `@corbits/artifacts` consumes the
 * postgres-js shape directly (`applied.map(...)` in its migration runner), so
 * the package throws on an otherwise-working pglite database.
 *
 * Everything else in that package goes through drizzle's query builder, which
 * is dialect-portable — so this one seam is the entire gap. Wrapping it here
 * keeps the divergence in the host, where the drizzle handle is already owned,
 * rather than forking the package. Section 14's reuse-first posture: adopt the
 * library, carry the small local change, and send it upstream.
 *
 * Upstream defect to file: `ArtifactDb` is typed `PostgresJsDatabase`, so a
 * pglite host is out of contract today. The fix is for the package to read
 * `Array.isArray(result) ? result : result.rows` at its seven `execute` sites.
 */

type ExecuteResult = { rows?: unknown[] } | unknown[];

/** The array shape postgres.js callers expect, without losing pglite's fields. */
function toRowArray(result: ExecuteResult): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = result?.rows ?? [];
  // Keep the original object's own properties reachable so a caller written
  // against either driver finds what it looks for.
  return Object.assign(Array.from(rows), result);
}

/**
 * Wraps a drizzle handle so `execute` resolves to rows, recursing into
 * `transaction` so the callback's `tx` behaves the same way.
 *
 * The proxy forwards every other property untouched — this adds a shim, it does
 * not re-implement a driver.
 */
export function withPostgresJsResultShape<T extends object>(handle: T): T {
  return new Proxy(handle, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      if (property === "execute") {
        return (...args: unknown[]) =>
          Promise.resolve(
            (value as (...a: unknown[]) => Promise<ExecuteResult>).apply(target, args),
          ).then(toRowArray);
      }

      if (property === "transaction") {
        return (
          callback: (tx: object) => unknown,
          ...rest: unknown[]
        ) =>
          (value as (...a: unknown[]) => unknown).apply(target, [
            (tx: object) => callback(withPostgresJsResultShape(tx)),
            ...rest,
          ]);
      }

      return value.bind(target);
    },
  });
}
