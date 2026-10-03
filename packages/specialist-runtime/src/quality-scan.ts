/**
 * The quality bar's deterministic half, read off an archive's extracted
 * files: stub markers and placeholder content, errors caught and dropped,
 * and whether the archive says how its tests run. Language-agnostic text
 * matching; it reads bytes and runs nothing.
 *
 * What it does not do is said as plainly: the tests are never run here (the
 * archive's code is untrusted and no sandbox runs it on the host), so a test
 * command found is "inaccessible", not a pass; and a marker this scan does
 * not know is not a clean bill.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { VerificationItem } from "./delivery.js";

export type QualityRule = "stub" | "placeholder" | "swallowed_error" | "unparseable";

export type QualityFinding = { path: string; line: number; rule: QualityRule; text: string };

export type TestCommand = { source: string; command: string };

export type QualityScan = {
  scannedFiles: number;
  /** Binary, oversized or lockfiles: not read, so not claimed clean. */
  skippedFiles: number;
  findings: QualityFinding[];
  testCommands: TestCommand[];
  testFiles: number;
};

const MAX_SCAN_BYTES = 1024 * 1024;
const LISTED_FINDINGS = 100;
const LOCKFILES = new Set(["package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum", "composer.lock", "Gemfile.lock"]);
const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

const LINE_RULES: readonly { rule: QualityRule; pattern: RegExp }[] = [
  { rule: "stub", pattern: /(?<![-\w])(TODO|FIXME|XXX)(?![-\w])/ },
  { rule: "stub", pattern: /\b[Nn]ot (yet )?implemented\b|NotImplemented(Error|Exception)\b|\bunimplemented!\(|\btodo!\(/ },
  { rule: "placeholder", pattern: /lorem ipsum/i },
];

const SWALLOWED: readonly RegExp[] = [
  /\bcatch\s*(\([^)]*\))?\s*\{(\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*\}/g,
  /\.catch\(\s*(\([^)]*\)|\w+)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\)/g,
  /\bexcept\b[^:\n]*:\s*(#[^\n]*\s*)*pass\b/g,
];

function isTestFile(path: string): boolean {
  const name = basename(path);
  return /[._-](test|spec)\.\w+$/.test(name) || /^test_.+\.py$/.test(name) || path.split("/").some((part) => part === "test" || part === "tests" || part === "__tests__");
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function scanText(path: string, text: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  // The README is told to name what was left unbuilt, so prose is not read for stub markers.
  if (!path.endsWith(".md")) {
    text.split("\n").forEach((raw, index) => {
      const rule = LINE_RULES.find((candidate) => candidate.pattern.test(raw))?.rule;
      if (rule) findings.push({ path, line: index + 1, rule, text: raw.trim().slice(0, 160) });
    });
  }
  for (const pattern of SWALLOWED) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ path, line: lineAt(text, match.index), rule: "swallowed_error", text: match[0].replace(/\s+/g, " ").slice(0, 160) });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

function testCommandsIn(path: string, text: string): TestCommand[] {
  const name = basename(path);
  const lines = text.split("\n").map((line) => line.trim());
  if (name === "package.json" || name === "deno.json") {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown>; tasks?: Record<string, unknown> };
    const field = name === "package.json" ? "scripts" : "tasks";
    const command = parsed[field]?.["test"];
    return typeof command === "string" && command !== NPM_DEFAULT_TEST ? [{ source: `${path} ${field}.test`, command }] : [];
  }
  if (name === "pytest.ini" || (name === "pyproject.toml" && lines.includes("[tool.pytest.ini_options]")) || (name === "setup.cfg" && lines.includes("[tool:pytest]")) || (name === "tox.ini" && lines.includes("[pytest]"))) {
    return [{ source: path, command: "pytest" }];
  }
  if (name === "Cargo.toml") return [{ source: path, command: "cargo test" }];
  if (name === "go.mod") return [{ source: path, command: "go test ./..." }];
  if (name === "Makefile" && lines.some((line) => line.startsWith("test:"))) return [{ source: `${path} test target`, command: "make test" }];
  return [];
}

/** Scans every listed file under `dir` (relative POSIX paths, as `hashTree` lists them). */
export async function scanQuality(dir: string, paths: readonly string[]): Promise<QualityScan> {
  const scan: QualityScan = { scannedFiles: 0, skippedFiles: 0, findings: [], testCommands: [], testFiles: 0 };
  for (const path of paths) {
    if (isTestFile(path)) scan.testFiles += 1;
    const bytes = await readFile(join(dir, path));
    if (LOCKFILES.has(basename(path)) || path.endsWith(".min.js") || path.endsWith(".map") || bytes.byteLength > MAX_SCAN_BYTES || bytes.subarray(0, 8192).includes(0)) {
      scan.skippedFiles += 1;
      continue;
    }
    scan.scannedFiles += 1;
    const text = bytes.toString("utf8");
    scan.findings.push(...scanText(path, text));
    try {
      scan.testCommands.push(...testCommandsIn(path, text));
    } catch (cause) {
      scan.findings.push({ path, line: 1, rule: "unparseable", text: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return scan;
}

const RULE_LABEL: Record<QualityRule, string> = {
  stub: "stub marker",
  placeholder: "placeholder content",
  swallowed_error: "error caught and dropped",
  unparseable: "does not parse",
};

/** The scan as checklist items: every finding a failed check at its location, and the tests never a pass; tests the host cannot run are shown, not owed. */
export function qualityItems(scan: QualityScan): VerificationItem[] {
  const items: VerificationItem[] = scan.findings.slice(0, LISTED_FINDINGS).map((finding) => ({
    category: "source",
    path: `${finding.path}:${String(finding.line)}`,
    required: true,
    status: "failed",
    checkedBy: "tool",
    detail: `${RULE_LABEL[finding.rule]}: ${finding.text}`,
  }));
  if (scan.findings.length > LISTED_FINDINGS) {
    items.push({ category: "source", path: "quality:unlisted", required: true, status: "failed", checkedBy: "tool", detail: `${String(scan.findings.length - LISTED_FINDINGS)} more findings not listed` });
  }
  const commands = scan.testCommands.map((entry) => `\`${entry.command}\` (${entry.source})`).join(", ");
  items.push(
    scan.testCommands.length === 0
      ? { category: "tests", path: "tests", required: true, status: "failed", checkedBy: "tool", detail: `no test command found; ${String(scan.testFiles)} test file(s)` }
      : { category: "tests", path: "tests", required: false, status: "inaccessible", checkedBy: "tool", detail: `not run by the host; test command ${commands}; ${String(scan.testFiles)} test file(s)` },
  );
  return items;
}
