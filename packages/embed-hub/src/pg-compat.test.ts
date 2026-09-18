import { describe, expect, test } from "bun:test";
import { withPostgresJsResultShape } from "./pg-compat.js";

describe("withPostgresJsResultShape", () => {
  test("execute turns a pglite { rows } result into a row array", async () => {
    const handle = {
      execute: async () => ({ rows: [{ id: "p_1" }], affectedRows: 1 }),
    };
    const shaped = withPostgresJsResultShape(handle);
    const rows = (await shaped.execute()) as unknown as { id: string }[] & { affectedRows: number };
    expect(Array.isArray(rows)).toBe(true);
    expect([...rows]).toEqual([{ id: "p_1" }]);
    expect(rows.affectedRows).toBe(1);
  });

  test("execute leaves an already-array result alone", async () => {
    const handle = {
      execute: async () => [{ id: "p_2" }],
    };
    const shaped = withPostgresJsResultShape(handle);
    expect(await shaped.execute()).toEqual([{ id: "p_2" }]);
  });

  test("transaction wraps the callback's tx the same way", async () => {
    const handle = {
      execute: async () => ({ rows: [{ ok: true }] }),
      transaction: async (callback: (tx: object) => unknown) => callback(handle),
    };
    const shaped = withPostgresJsResultShape(handle);
    const rows = await shaped.transaction((tx) =>
      (tx as { execute: () => Promise<unknown[]> }).execute(),
    );
    expect(rows).toEqual([{ ok: true }]);
  });
});
