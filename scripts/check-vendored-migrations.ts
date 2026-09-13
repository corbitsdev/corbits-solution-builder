/**
 * Fails when the vendored database package's migration list drifts from the
 * SQL beside it.
 *
 * The list in `apps/hub/src/hub-migrations.ts` is explicit because a bundler cannot glob,
 * and it is what the compiled host carries. A vendor refresh that adds or
 * removes a migration without touching the list would ship a schema that is
 * silently incomplete, so the two are compared here instead.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { HUB_MIGRATIONS } from "../apps/hub/src/hub-migrations.js";

const dir = join(import.meta.dir, "..", "vendor", "interchange", "packages", "db", "migrations");
const onDisk = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
const exported = HUB_MIGRATIONS.map((migration) => migration.id);

const missing = onDisk.filter((id) => !exported.includes(id));
const extra = exported.filter((id) => !onDisk.includes(id));
const misordered = exported.join("\n") !== [...exported].sort().join("\n");

if (missing.length > 0 || extra.length > 0 || misordered) {
  if (missing.length > 0) console.error(`Not imported by apps/hub/src/hub-migrations.ts: ${missing.join(", ")}`);
  if (extra.length > 0) console.error(`Exported but absent from the directory: ${extra.join(", ")}`);
  if (misordered) console.error("The exported list is not in application order.");
  console.error("\nUpdate apps/hub/src/hub-migrations.ts to match.");
  process.exit(1);
}

console.log(`${exported.length} migrations exported, matching the directory.`);
