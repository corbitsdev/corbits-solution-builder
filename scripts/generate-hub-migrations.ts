/**
 * Embeds Interchange's migrations into a TypeScript module.
 *
 * The compiled sidecar is one file with no directory beside it, so reading the
 * vendored `.sql` files at runtime works from source and fails in the packaged
 * app. Generating them into a module makes them part of the binary.
 *
 * The SQL is copied verbatim — Solutions Builder does not own the hub's schema
 * and must not edit it in passing. `--check` verifies the generated file is
 * current, so a vendor refresh that forgets to regenerate fails the build
 * rather than shipping a stale schema.
 *
 * Usage: bun scripts/generate-hub-migrations.ts [--check]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "vendor", "interchange", "packages", "db", "migrations");
const target = join(root, "apps", "hub", "hub-migrations.generated.ts");

const files = (await readdir(source)).filter((name) => name.endsWith(".sql")).sort();
const entries: string[] = [];

for (const file of files) {
  const body = await readFile(join(source, file), "utf8");
  // A template literal keeps the SQL readable in the generated file; the three
  // sequences below are the only ones that would terminate or interpolate it.
  const escaped = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  entries.push(`  {\n    id: ${JSON.stringify(file)},\n    sql: \`${escaped}\`,\n  },`);
}

const generated = `/**
 * GENERATED — do not edit. Run \`bun run generate:hub-migrations\`.
 *
 * Interchange's migrations, verbatim, from
 * vendor/interchange/packages/db/migrations at the revision in
 * vendor/interchange/VENDORED_REVISION. They live here as a module so the
 * compiled single-file host carries them; reading them from disk works only
 * from a source checkout.
 */
export type HubMigration = { readonly id: string; readonly sql: string };

export const HUB_MIGRATIONS: readonly HubMigration[] = [
${entries.join("\n")}
];
`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== generated) {
    console.error(
      "apps/hub/hub-migrations.generated.ts is stale.\n" +
        "Run `bun run generate:hub-migrations` after refreshing the vendored Interchange tree.",
    );
    process.exit(1);
  }
  console.log(`Hub migrations are current (${files.length} files).`);
  process.exit(0);
}

await writeFile(target, generated);
console.log(`Embedded ${files.length} Interchange migrations.`);
