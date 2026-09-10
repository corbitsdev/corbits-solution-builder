/**
 * Seeding the curated kit — BUILD_PLAN_V3 §8.
 *
 * Idempotent the same way the workflows are: each record is keyed on a hash of
 * its own body, so re-seeding an unchanged kit writes nothing, and changing one
 * prompt versions exactly that prompt while everything else keeps its version.
 * §8's requirement is "versioned native records", and a version that moves
 * because something else changed is not a version.
 */
import { and, desc, eq } from "drizzle-orm";
import { database } from "../db/client.js";
import * as table from "../db/schema.js";
import { sha256 } from "../ids.js";
import { baseTemplate, violationsIn } from "../../contracts/template.js";
import { kitSeed } from "../../orchestration/agents/seed-kit.js";

export type SeededRecord = {
  readonly kind: string;
  readonly key: string;
  readonly version: number;
  readonly created: boolean;
};

/** Every record in the kit, flattened to what the table stores. */
function entries(): { kind: string; key: string; body: unknown }[] {
  const seed = kitSeed();
  const template = baseTemplate();
  const broken = violationsIn(template);
  if (broken.length > 0) {
    // The base template failing its own rules would mean the rules and the
    // ledger disagree, and seeding it would make that disagreement durable.
    throw new Error(`The base workflow template is invalid: ${broken.join(" ")}`);
  }

  return [
    { kind: "template", key: template.key, body: template },
    ...seed.prompts.map((body) => ({ kind: "prompt", key: body.key, body })),
    ...seed.skills.map((body) => ({ kind: "skill", key: body.key, body })),
    ...seed.tools.map((body) => ({ kind: "tool", key: body.key, body })),
    ...seed.grants.map((body) => ({ kind: "grant", key: body.key, body })),
    ...seed.directors.map((body) => ({ kind: "director", key: body.key, body })),
    ...seed.models.map((body) => ({ kind: "model", key: body.key, body })),
    ...seed.agents.map((body) => ({ kind: "agent", key: body.key, body })),
  ];
}

export async function seedKit(): Promise<SeededRecord[]> {
  const { db } = database();
  const seeded: SeededRecord[] = [];

  for (const entry of entries()) {
    const wireHash = await sha256(JSON.stringify(entry.body));
    const existing = await db
      .select()
      .from(table.kitRecord)
      .where(and(eq(table.kitRecord.kind, entry.kind), eq(table.kitRecord.key, entry.key)))
      .orderBy(desc(table.kitRecord.version));

    const matching = existing.find((row) => row.wireHash === wireHash);
    if (matching) {
      seeded.push({ kind: entry.kind, key: entry.key, version: matching.version, created: false });
      continue;
    }

    // A changed record is a new version beside the old one, never an edit:
    // a draft produced last week names the prompt version it was produced
    // from, and that record has to still exist to be named.
    const version = (existing[0]?.version ?? 0) + 1;
    await db.insert(table.kitRecord).values({
      kind: entry.kind,
      key: entry.key,
      version,
      body: entry.body,
      wireHash,
    });
    seeded.push({ kind: entry.kind, key: entry.key, version, created: true });
  }

  return seeded;
}

/** The kit as stored, newest version of each record. */
export async function storedKit(): Promise<{ kind: string; key: string; version: number }[]> {
  const { db } = database();
  const rows = await db.select().from(table.kitRecord).orderBy(desc(table.kitRecord.version));
  const newest = new Map<string, { kind: string; key: string; version: number }>();
  for (const row of rows) {
    const id = `${row.kind}:${row.key}`;
    if (!newest.has(id)) newest.set(id, { kind: row.kind, key: row.key, version: row.version });
  }
  return [...newest.values()];
}
