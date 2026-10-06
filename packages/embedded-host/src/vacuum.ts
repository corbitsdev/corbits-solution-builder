/**
 * Keeps the embedded database compact (#779).
 *
 * pglite runs Postgres on the host's own thread, so a query that reads a
 * table reads it while every request waits. Postgres leaves a dead row
 * behind every update and relies on autovacuum to reclaim them; pglite has
 * no autovacuum. A table that is rewritten constantly (a lease column, a
 * next-attempt timestamp) grows without bound, and every query over it
 * reads the whole heap: a 271-row allocation table reached 356 MB, and the
 * host stalled for seconds at a time with nothing in the log to say why.
 *
 * Two passes, by measurement rather than by name:
 *   - a table whose heap holds far more bytes per row than a row could
 *     need is bloated and is rewritten (`VACUUM FULL`), which takes a
 *     moment and returns the space;
 *   - a table that merely grew since the last pass is vacuumed plainly,
 *     which marks its dead rows reusable so it stops growing.
 * The heap alone is measured, not TOAST: a table of large documents keeps
 * a pointer per row in its heap and its bulk out of line, and is not bloat.
 */

export const BLOAT_MIN_HEAP_BYTES = 8 * 1024 * 1024;
/** A row's heap share above which the table is almost all dead rows. */
export const BLOAT_HEAP_BYTES_PER_ROW = 16 * 1024;
/** Growth since the last pass that earns a plain vacuum. */
export const GROWTH_STEP_BYTES = 8 * 1024 * 1024;
export const COMPACT_EVERY_MS = 10 * 60 * 1000;

export type TableSize = {
  readonly schema: string;
  readonly name: string;
  /** The heap (main fork) alone. */
  readonly heapBytes: number;
  /** Heap, indexes and TOAST together. */
  readonly totalBytes: number;
};

export type CompactionPlan = {
  /** Tables to rewrite: bloated beyond what their rows could need. */
  readonly full: readonly TableSize[];
  /** Tables to vacuum plainly: grown since the last pass. */
  readonly plain: readonly TableSize[];
};

type Client = {
  query<T>(sql: string): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
};

export type Log = (line: string) => void;

/** `rows` is known only for tables large enough to be worth counting. */
export function compactionPlan(tables: readonly TableSize[], rows: ReadonlyMap<string, number>, previous: ReadonlyMap<string, number>): CompactionPlan {
  const full: TableSize[] = [];
  const plain: TableSize[] = [];
  for (const table of tables) {
    const key = qualified(table);
    const count = rows.get(key);
    if (table.heapBytes >= BLOAT_MIN_HEAP_BYTES && count !== undefined && table.heapBytes / Math.max(count, 1) >= BLOAT_HEAP_BYTES_PER_ROW) {
      full.push(table);
      continue;
    }
    const before = previous.get(key);
    if (before !== undefined && table.totalBytes - before >= GROWTH_STEP_BYTES) plain.push(table);
  }
  return { full, plain };
}

export const qualified = (table: Pick<TableSize, "schema" | "name">): string => `${table.schema}.${table.name}`;

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

export async function tableSizes(client: Client): Promise<TableSize[]> {
  const result = await client.query<{ schema: string; name: string; heap: string | number; total: string | number }>(
    `select n.nspname as schema, c.relname as name, pg_relation_size(c.oid) as heap, pg_total_relation_size(c.oid) as total
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
      order by pg_total_relation_size(c.oid) desc`,
  );
  return result.rows.map((row) => ({ schema: row.schema, name: row.name, heapBytes: Number(row.heap), totalBytes: Number(row.total) }));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${String(bytes)} B`;
}

/**
 * One pass: measures, rewrites what is bloated, vacuums what grew, and says
 * what it did. Returns the sizes after the pass, for the next one's growth
 * check. A table that cannot be vacuumed is said and skipped; the pass
 * never fails the host.
 */
export async function compactDatabase(client: Client, log: Log, previous: ReadonlyMap<string, number> = new Map()): Promise<Map<string, number>> {
  const tables = await tableSizes(client);
  const rows = new Map<string, number>();
  for (const table of tables) {
    if (table.heapBytes < BLOAT_MIN_HEAP_BYTES) continue;
    const counted = await client.query<{ n: string | number }>(`select count(*) as n from ${quote(table.schema)}.${quote(table.name)}`);
    rows.set(qualified(table), Number(counted.rows[0]?.n ?? 0));
  }
  const plan = compactionPlan(tables, rows, previous);
  for (const table of plan.full) {
    const started = Date.now();
    try {
      await client.exec(`VACUUM FULL ${quote(table.schema)}.${quote(table.name)}`);
      const after = (await tableSizes(client)).find((entry) => qualified(entry) === qualified(table));
      log(
        `Compacted ${table.name}: ${formatBytes(table.totalBytes)} → ${formatBytes(after?.totalBytes ?? 0)} for ${String(rows.get(qualified(table)) ?? 0)} rows, in ${String(Date.now() - started)} ms`,
      );
    } catch (cause) {
      log(`Could not compact ${table.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  for (const table of plan.plain) {
    try {
      await client.exec(`VACUUM ${quote(table.schema)}.${quote(table.name)}`);
      log(`Vacuumed ${table.name}: grew to ${formatBytes(table.totalBytes)} since the last pass`);
    } catch (cause) {
      log(`Could not vacuum ${table.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const sizes = plan.full.length > 0 ? await tableSizes(client) : tables;
  return new Map(sizes.map((table) => [qualified(table), table.totalBytes]));
}

/**
 * A pass now, then one every `everyMs`, each reading the sizes the last one
 * left. The timer never keeps the host alive by itself; `stop` ends it and
 * waits for a pass in progress.
 */
export function startCompaction(client: Client, log: Log, everyMs = COMPACT_EVERY_MS): { first: Promise<void>; stop: () => Promise<void> } {
  let previous = new Map<string, number>();
  let running: Promise<void> = Promise.resolve();
  const pass = () => {
    running = running.then(async () => {
      previous = await compactDatabase(client, log, previous);
    }).catch((cause: unknown) => log(`The compaction pass failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    return running;
  };
  const first = pass();
  const timer = setInterval(() => void pass(), everyMs);
  timer.unref?.();
  return {
    first,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
