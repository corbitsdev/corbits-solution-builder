#!/usr/bin/env bun
/**
 * The gate runs as parallel CI jobs, so its definition lives in two places: the
 * `check:<shard>` scripts and the workflow's matrix. A smoke added to one and
 * not the other would pass unnoticed — silently ungated, which is the failure
 * the gate exists to prevent. Asserts the two agree, and that every smoke and
 * check is reachable from `check` or `check:full` unless named ungated here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "check.yml");

const UNGATED = new Map<string, string>([]);

const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const steps = (name: string): string[] =>
  scripts[name]?.split("&&").map((step) => step.trim().replace(/^bun run /, "")) ?? [];

/** Every script `name` runs, however deeply it delegates. */
function reachable(name: string, seen = new Set([name])): Set<string> {
  for (const step of steps(name)) if (!seen.has(step)) reachable(step, seen.add(step));
  return seen;
}

const failures: string[] = [];
const shards = steps("check");

const matrix = readFileSync(WORKFLOW, "utf8").match(/^\s*shard:\s*\[(.*)\]\s*$/m)?.[1];
if (matrix === undefined) {
  failures.push(`${WORKFLOW} has no 'shard: [...]' matrix to compare against`);
} else {
  const inCI = matrix.split(",").map((entry) => `check:${entry.trim()}`);
  for (const shard of shards) {
    if (!inCI.includes(shard)) failures.push(`${shard} runs in 'check' but no CI job runs it`);
  }
  for (const shard of inCI) {
    if (!shards.includes(shard)) failures.push(`CI runs ${shard}, which 'check' does not`);
  }
}

/** A step in two shards runs twice in CI and occupies a runner for nothing. */
const owner = new Map<string, string>();
for (const shard of shards) {
  for (const step of steps(shard)) {
    const first = owner.get(step);
    if (first) failures.push(`${step} runs in both ${first} and ${shard}`);
    owner.set(step, first ?? shard);
  }
}

const gated = new Set([...reachable("check"), ...reachable("check:full")]);
for (const name of Object.keys(scripts)) {
  if (!name.startsWith("smoke") && !name.startsWith("check:")) continue;
  const ungated = UNGATED.get(name);
  if (gated.has(name) && ungated) failures.push(`${name} is named ungated (${ungated}) but a gate runs it`);
  if (!gated.has(name) && !ungated) {
    failures.push(`${name} runs in no gate; add it to a shard or check:full, or name it ungated`);
  }
}

if (failures.length > 0) {
  console.error(`check-shards: the gate and its CI matrix disagree\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-shards: ${shards.length} shards, ${owner.size} steps, ${gated.size} gated, CI agrees`);
