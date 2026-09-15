/**
 * Which coding agent the bounded bridge runs at stage 8, and how.
 *
 * Each worker is one CLI with a non-interactive form the bridge can hand a
 * prompt to. Only what the bridge needs is recorded here: the executable,
 * how to ask it whether it is present, and how to run it once. Nothing about
 * a worker's own sessions, permissions or output shape is modelled — the
 * bridge reports final text and an exit status whichever tool it ran.
 *
 * The choice is a file beside the designer's settings, read at every probe
 * and every attempt, so a change in Settings takes effect on the next
 * attempt without a restart. The client reads and writes it through the
 * host's preferences API under `build.*` keys.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type } from "arktype";
import { HostError } from "./errors.js";
import { buildWorkerSettingsFile } from "./paths.js";

export type BuildWorkerId = "corbits-code" | "claude-code" | "codex";

export type BuildWorkerKind = {
  readonly id: BuildWorkerId;
  readonly label: string;
  /** The executable's name on PATH when no path is given. */
  readonly executable: string;
  /** Arguments that make the executable answer without doing any work. */
  readonly probe: readonly string[];
  /** A word the probe's output must contain, where the version alone would not prove the verb exists. */
  readonly probeExpects: string | null;
  /** Arguments that run one attempt on a prompt and end. */
  readonly run: (prompt: string) => readonly string[];
  /**
   * How the worker reports each turn while it runs, where it can: the files
   * to place in its working directory so its own lifecycle hook appends every
   * turn to the log at `log`. Null for a worker with no such interface, whose
   * live output is its stdout alone.
   */
  readonly turnReports: null | { install: (log: string) => readonly { path: string; content: string }[] };
};

/**
 * Corbits Code discovers shell hooks in `.corbits/hooks/` under its working
 * directory and hands each lifecycle kind its payload as JSON on stdin:
 * `postTurn` the turn, `postRun` the whole run. The hook appends turns, one
 * record a line, to the log named when it was written, and reads every
 * other payload to its end and discards it — a hook that exits without
 * reading closes the pipe under a run summary too large to buffer, and
 * Corbits 0.3.24 dies on the broken pipe after a finished build. Ignored by
 * git inside that directory so the built software never ships it.
 */
function corbitsTurnHook(log: string): readonly { path: string; content: string }[] {
  const quoted = `'${log.replace(/'/g, `'\\''`)}'`;
  return [
    {
      path: ".corbits/hooks/solutions-builder-turns.sh",
      content: [
        "#!/bin/sh",
        "# Placed by Solutions Builder for one build attempt: each turn's report, appended as a line.",
        "# Every other payload is read to its end so the writer never meets a closed pipe.",
        'case "$1" in',
        `  postTurn) cat >> ${quoted}; printf '\\n' >> ${quoted} ;;`,
        "  *) cat > /dev/null ;;",
        "esac",
        "",
      ].join("\n"),
    },
    { path: ".corbits/hooks/.gitignore", content: "solutions-builder-turns.sh\n" },
  ];
}

/** In the order Settings offers them; the first is the default. */
export const BUILD_WORKERS: readonly BuildWorkerKind[] = [
  {
    id: "corbits-code",
    label: "Corbits Code",
    executable: "corbits",
    probe: ["--help"],
    probeExpects: "exec",
    // No permission flag at all: `corbits exec` has none besides the
    // bypass this bridge refuses to pass. Checked live — execution then
    // follows the operator's own saved default in ~/.corbits/settings.json
    // (corbits's own /yolo toggle), outside this bridge's control either
    // way. Nothing to add here without reaching for the bypass.
    run: (prompt) => ["exec", prompt],
    turnReports: { install: corbitsTurnHook },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    executable: "claude",
    probe: ["--version"],
    probeExpects: null,
    // acceptEdits lets the worker write within the session without the
    // blanket --dangerously-skip-permissions bypass the bridge refuses to
    // pass. Edits alone can't run the toolchain the workspace was seeded
    // with (build-workspace.ts: bun test, bun run typecheck -> tsc), so
    // --allowedTools names exactly those binaries plus git, which the
    // worker needs to commit its own progress for the bridge to see it.
    // Verified against `claude --help` on the installed CLI (2.1.271):
    // --allowedTools takes Bash(<binary>:*) patterns and everything else
    // still requires approval, which a non-interactive session can't give.
    run: (prompt) => [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(bun:*) Bash(node:*) Bash(tsc:*) Bash(git:*)",
    ],
    turnReports: null,
  },
  {
    id: "codex",
    label: "Codex",
    executable: "codex",
    probe: ["--version"],
    probeExpects: null,
    // workspace-write scopes writes to the workspace (plus /tmp), short of a
    // full bypass. No --skip-git-repo-check: build-workspace.ts git-inits
    // every fresh workspace, so codex's own git-repo check already passes
    // (it accepts an unborn repo too, before the baseline commit lands).
    // Checked, not assumed: `codex exec -s workspace-write` runs with
    // `approval: never` by default (confirmed in a live run's banner), and
    // the sandbox governs filesystem/network scope, not whether commands
    // execute at all — a real `bun --version` ran inside it with no
    // approval prompt. Nothing to widen here.
    run: (prompt) => ["exec", "-s", "workspace-write", prompt],
    turnReports: null,
  },
];

export const DEFAULT_BUILD_WORKER: BuildWorkerId = "corbits-code";

const Settings = type({
  worker: "'corbits-code' | 'claude-code' | 'codex'",
  /** A path to the executable, for an install that is not on the host's PATH. Empty means the worker's own name. */
  executable: "string",
});

export type BuildWorkerSettings = typeof Settings.infer;

export const DEFAULT_BUILD_WORKER_SETTINGS: BuildWorkerSettings = {
  worker: DEFAULT_BUILD_WORKER,
  executable: "",
};

/** The settings as saved, with defaults for anything missing or unreadable. */
export async function buildWorkerSettings(): Promise<BuildWorkerSettings> {
  try {
    const raw = JSON.parse(await readFile(buildWorkerSettingsFile(), "utf8")) as unknown;
    const parsed = Settings({ ...DEFAULT_BUILD_WORKER_SETTINGS, ...(raw as object) });
    return parsed instanceof type.errors ? DEFAULT_BUILD_WORKER_SETTINGS : parsed;
  } catch {
    return DEFAULT_BUILD_WORKER_SETTINGS;
  }
}

/** Saves are one after another: two in flight at once would each write the other's change away. */
let writing: Promise<unknown> = Promise.resolve();

/** Saves a change to one or both settings, refusing a value the type rejects. */
export function saveBuildWorkerSettings(patch: Partial<BuildWorkerSettings>): Promise<BuildWorkerSettings> {
  const turn = writing.then(() => writeBuildWorkerSettings(patch));
  writing = turn.catch(() => undefined);
  return turn;
}

async function writeBuildWorkerSettings(patch: Partial<BuildWorkerSettings>): Promise<BuildWorkerSettings> {
  const next = Settings({
    ...(await buildWorkerSettings()),
    ...patch,
    ...(typeof patch.executable === "string" ? { executable: patch.executable.trim() } : {}),
  });
  if (next instanceof type.errors) {
    throw new HostError("validation_failed", `Build worker settings: ${next.summary}`);
  }
  const file = buildWorkerSettingsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** The worker the bridge runs right now: the chosen kind, and the executable it resolves to. */
export type BuildWorker = BuildWorkerKind & { readonly command: string };

/**
 * Resolves the chosen worker. The executable is, in order, the environment's
 * override (what the smokes use to stand in a worker), the path saved in
 * Settings, or the worker's own name on PATH.
 */
export async function buildWorker(): Promise<BuildWorker> {
  const settings = await buildWorkerSettings();
  const kind = BUILD_WORKERS.find((entry) => entry.id === settings.worker) ?? BUILD_WORKERS[0]!;
  const override =
    process.env.SOLUTIONS_BUILDER_WORKER_BIN?.trim() || process.env.SOLUTIONS_BUILDER_CORBITS_BIN?.trim();
  return { ...kind, command: override || settings.executable || kind.executable };
}
