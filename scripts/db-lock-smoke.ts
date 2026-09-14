/**
 * pglite is single-writer and WASM-aborts if a previous process left
 * `postmaster.pid` behind. The host must recover from that crash and refuse a
 * live second writer, rather than dying with `RuntimeError: Aborted()`.
 */
import "./smoke-env.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../apps/hub/src/db.js";

const probeIndex = process.argv.indexOf("--probe");
if (probeIndex >= 0) {
  const dir = process.argv[probeIndex + 1];
  if (!dir) {
    console.error("--probe needs a directory");
    process.exit(1);
  }
  try {
    await openDatabase(dir);
    console.log("opened");
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const stalePid = "-42\n/tmp/pglite/base\n1789057948\n5432\n\n\n336346527       666\n";

{
  const dir = await mkdtemp(join(tmpdir(), "sb-db-stale-"));
  const pglite = join(dir, "pglite");
  await mkdir(pglite, { recursive: true });
  await writeFile(join(pglite, "postmaster.pid"), stalePid);
  try {
    const host = await openDatabase(pglite);
    try {
      const result = await host.raw.query<{ n: number }>("select 1 as n");
      check("a leftover postmaster.pid does not brick an empty directory", result.rows[0]?.n === 1);
    } finally {
      await host.close();
    }
  } catch (error) {
    check(
      "a leftover postmaster.pid does not brick an empty directory",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "sb-db-crash-"));
  const pglite = join(dir, "pglite");
  const first = await openDatabase(pglite);
  try {
    await first.raw.exec("create table crash_probe (id int primary key, note text)");
    await first.raw.exec("insert into crash_probe values (1, 'still here')");
  } finally {
    await first.close();
  }
  await writeFile(join(pglite, "postmaster.pid"), stalePid);
  try {
    const second = await openDatabase(pglite);
    try {
      const result = await second.raw.query<{ note: string }>("select note from crash_probe where id = 1");
      check("a crash lock on a populated directory still reads its rows", result.rows[0]?.note === "still here");
    } finally {
      await second.close();
    }
  } catch (error) {
    check(
      "a crash lock on a populated directory still reads its rows",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "sb-db-live-"));
  const pglite = join(dir, "pglite");
  const first = await openDatabase(pglite);
  try {
    const child = Bun.spawn(["bun", "--conditions", "intx-src", import.meta.path, "--probe", pglite], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exited = await child.exited;
    const stderr = (await new Response(child.stderr).text()).trim();
    const stdout = (await new Response(child.stdout).text()).trim();
    check(
      "a second host is refused while the first still holds the directory",
      exited !== 0 && stderr.includes("already running") && stdout !== "opened",
      stderr || stdout || `exit ${exited}`,
    );
  } finally {
    await first.close();
  }
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nDatabase lock smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
