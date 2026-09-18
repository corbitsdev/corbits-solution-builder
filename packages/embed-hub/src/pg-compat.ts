/**
 * Result-shape adapter between pglite's drizzle handle and Interchange stores
 * written against postgres.js.
 *
 * drizzle's `postgres-js` driver resolves `db.execute()` to a row array, while
 * the `pglite` driver resolves it to `{ rows, fields, affectedRows }`. The
 * platform's stores expect the array shape. Wrapping the handle here is the
 * whole pglite seam; it is not a fork of those stores.
 */

type ExecuteResult = { rows?: unknown[] } | unknown[];

/** The array shape postgres.js callers expect, without losing pglite's fields. */
function toRowArray(result: ExecuteResult): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = result?.rows ?? [];
  return Object.assign(Array.from(rows), result);
}

/**
 * Wraps a drizzle handle so `execute` resolves to rows, recursing into
 * `transaction` so the callback's `tx` behaves the same way.
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
        return (callback: (tx: object) => unknown, ...rest: unknown[]) =>
          (value as (...a: unknown[]) => unknown).apply(target, [
            (tx: object) => callback(withPostgresJsResultShape(tx)),
            ...rest,
          ]);
      }

      return value.bind(target);
    },
  });
}
