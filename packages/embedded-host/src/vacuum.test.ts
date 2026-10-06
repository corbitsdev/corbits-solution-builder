import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { BLOAT_HEAP_BYTES_PER_ROW, BLOAT_MIN_HEAP_BYTES, compactDatabase, compactionPlan, formatBytes, GROWTH_STEP_BYTES, startCompaction, tableSizes, type TableSize } from "./vacuum.ts";

const MB = 1024 * 1024;
const table = (name: string, heapBytes: number, totalBytes = heapBytes): TableSize => ({ schema: "public", name, heapBytes, totalBytes });

describe("compactionPlan", () => {
  test("a table whose heap is almost all dead rows is rewritten; one of large documents is not", () => {
    const bloated = table("sidecar_allocation", 356 * MB);
    const documents = table("artifact_version", 2 * MB, 80 * MB);
    const plan = compactionPlan([bloated, documents], new Map([["public.sidecar_allocation", 271]]), new Map());
    expect(plan.full).toEqual([bloated]);
    expect(plan.plain).toEqual([]);
  });

  test("a small table is never counted or rewritten, whatever its ratio", () => {
    const small = table("port", BLOAT_MIN_HEAP_BYTES - 1);
    expect(compactionPlan([small], new Map([["public.port", 1]]), new Map()).full).toEqual([]);
  });

  test("the ratio is per row: many legitimate rows in a big heap are left alone", () => {
    const busy = table("events", 64 * MB);
    const rows = Math.ceil((64 * MB) / BLOAT_HEAP_BYTES_PER_ROW) + 1;
    expect(compactionPlan([busy], new Map([["public.events", rows]]), new Map()).full).toEqual([]);
  });

  test("a table that grew by a step since the last pass is vacuumed plainly, not rewritten", () => {
    const grown = table("workflow_run_dispatch", 4 * MB, 20 * MB);
    const plan = compactionPlan([grown], new Map(), new Map([["public.workflow_run_dispatch", 20 * MB - GROWTH_STEP_BYTES]]));
    expect(plan.plain).toEqual([grown]);
    expect(compactionPlan([grown], new Map(), new Map([["public.workflow_run_dispatch", 20 * MB - GROWTH_STEP_BYTES + 1]])).plain).toEqual([]);
  });

  test("a table never seen before is not vacuumed for growth", () => {
    expect(compactionPlan([table("new", 4 * MB, 40 * MB)], new Map(), new Map()).plain).toEqual([]);
  });
});

describe("formatBytes", () => {
  test("says bytes the way a person reads them", () => {
    expect(formatBytes(320 * 1024)).toBe("320 kB");
    expect(formatBytes(356 * MB)).toBe("356 MB");
    expect(formatBytes(1.5 * MB)).toBe("1.5 MB");
    expect(formatBytes(12)).toBe("12 B");
  });
});

describe("compactDatabase", () => {
  test("rewrites a table bloated by updates, says so, and returns the sizes after", async () => {
    const db = await PGlite.create();
    try {
      await db.exec(`create table lease (id int primary key, note text, updated_at timestamptz)`);
      // Rows kept in the heap uncompressed, four to a page, so an update of
      // every row at once finds no room in its page and the heap extends;
      // without a vacuum the free space the old versions leave is never
      // found again, which is how a small table grows without bound.
      await db.exec(`alter table lease alter column note set storage plain`);
      await db.exec(`insert into lease select g, repeat('x', 1900), now() from generate_series(1, 300) g`);
      for (let round = 0; round < 24; round += 1) await db.exec(`update lease set note = repeat('y', 1900), updated_at = now()`);
      const before = (await tableSizes(db)).find((entry) => entry.name === "lease");
      expect(before).toBeDefined();
      expect(before!.heapBytes).toBeGreaterThanOrEqual(BLOAT_MIN_HEAP_BYTES);

      const lines: string[] = [];
      const sizes = await compactDatabase(db, (line) => lines.push(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Compacted lease: \d+(\.\d)? MB → \d+ kB for 300 rows, in \d+ ms$/);
      const after = (await tableSizes(db)).find((entry) => entry.name === "lease");
      expect(after!.heapBytes).toBeLessThan(before!.heapBytes / 10);
      expect(sizes.get("public.lease")).toBe(after!.totalBytes);
      expect((await db.query<{ n: number }>(`select count(*)::int as n from lease`)).rows[0]?.n).toBe(300);

      // A second pass over the same sizes has nothing to do and says nothing.
      const again: string[] = [];
      await compactDatabase(db, (line) => again.push(line), sizes);
      expect(again).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);

  test("startCompaction runs a first pass at once and can be stopped", async () => {
    const db = await PGlite.create();
    try {
      const lines: string[] = [];
      const compaction = startCompaction(db, (line) => lines.push(line), 60 * 60 * 1000);
      await compaction.first;
      await compaction.stop();
      expect(lines).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
