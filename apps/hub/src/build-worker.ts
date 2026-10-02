/**
 * Which coding agent the bounded bridge runs at stage 8, and how.
 *
 * Each worker is one CLI with a non-interactive form the bridge can hand a
 * prompt to. Only what the bridge needs is recorded here: the executable,
 * how to ask it whether it is present, and how to run it once. Nothing about
 * a worker's own sessions, permissions or output shape is modelled — the
 * bridge reports final text and an exit status whichever tool it ran.
 *
 * The choice is a file in the host's data directory, read at every probe
 * and every attempt, so a change in Settings takes effect on the next
 * attempt without a restart. The client reads and writes it through
 * `/api/build/worker`.
 *
 * When the binary is absent the host also says how to get it, for the
 * operating system it is running on. An instruction is only offered where
 * the package it names was seen to exist; where it was not, the pointer is
 * marked unverified rather than dressed up as an install command.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type } from "arktype";
import { dataDirectory, HostError } from "@corbits/embedded-host";

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
  /** Arguments that run one attempt on a prompt and end. Never a permission-skipping flag. */
  readonly run: (prompt: string) => readonly string[];
  /**
   * How the worker reports each turn while it runs, where it can: the files
   * to place in its working directory so its own lifecycle hook appends every
   * turn to the log at `log`. Null for a worker with no such interface, whose
   * live output is its stdout alone.
   */
  readonly turnReports: null | { install: (log: string) => readonly { path: string; content: string }[] };
  /** Where the tool comes from, for the instruction shown when it is absent. */
  readonly install: WorkerInstall;
};

/**
 * How a worker is obtained. `npm` names a package `npm view` answered for;
 * `download` is a page to read, offered only when no package was found,
 * and said to be unverified because nothing here has confirmed what it
 * hosts.
 */
export type WorkerInstall =
  | { readonly kind: "npm"; readonly package: string }
  | { readonly kind: "download"; readonly url: string; readonly verified: false };

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
      path: ".corbits/hooks/solution-builder-turns.sh",
      content: [
        "#!/bin/sh",
        "# Placed by Solution Builder for one build attempt: each turn's report, appended as a line.",
        "# Every other payload is read to its end so the writer never meets a closed pipe.",
        'case "$1" in',
        `  postTurn) cat >> ${quoted}; printf '\\n' >> ${quoted} ;;`,
        "  *) cat > /dev/null ;;",
        "esac",
        "",
      ].join("\n"),
    },
    { path: ".corbits/hooks/.gitignore", content: "solution-builder-turns.sh\n" },
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
    run: (prompt) => ["exec", prompt],
    turnReports: { install: corbitsTurnHook },
    // `npm view @corbits/code version` answered 404 when this was written:
    // there is no package to install, so the pointer is the repository, and
    // it is said to be unverified.
    install: { kind: "download", url: "https://github.com/corbitsdev/corbits-code", verified: false },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    executable: "claude",
    probe: ["--version"],
    probeExpects: null,
    run: (prompt) => ["-p", prompt],
    turnReports: null,
    install: { kind: "npm", package: "@anthropic-ai/claude-code" },
  },
  {
    id: "codex",
    label: "Codex",
    executable: "codex",
    probe: ["--version"],
    probeExpects: null,
    run: (prompt) => ["exec", prompt],
    turnReports: null,
    install: { kind: "npm", package: "@openai/codex" },
  },
];

export const DEFAULT_BUILD_WORKER: BuildWorkerId = "corbits-code";

export type HostPlatform = "macos" | "linux" | "windows";

/** The host's operating system, as the instruction names it. */
export function hostPlatform(platform: NodeJS.Platform = process.platform): HostPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

const PLATFORM_LABEL: Record<HostPlatform, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

export type InstallInstruction = {
  readonly platform: HostPlatform;
  /** What is missing, by the name the shell would look for. */
  readonly binary: string;
  /** One line a person can act on. */
  readonly text: string;
  /** A command to run, where one is known to exist. */
  readonly command: string | null;
  /** A page to read instead, where no command is known. */
  readonly url: string | null;
  /** False when the pointer was never confirmed to host an installable release. */
  readonly verified: boolean;
};

/**
 * How to get an absent worker on this host. Pure: the worker kind and the
 * platform decide the text, so the wording is tested without a shell.
 */
export function installInstruction(worker: BuildWorkerKind, platform: HostPlatform): InstallInstruction {
  const os = PLATFORM_LABEL[platform];
  const where = platform === "windows" ? "a PowerShell or Command Prompt window" : "a terminal";
  if (worker.install.kind === "npm") {
    const command = `npm install -g ${worker.install.package}`;
    const node =
      platform === "macos"
        ? "Node.js from https://nodejs.org or `brew install node` if you use Homebrew"
        : platform === "linux"
          ? "Node.js from https://nodejs.org or your distribution's package manager"
          : "Node.js from https://nodejs.org";
    return {
      platform,
      binary: worker.executable,
      command,
      url: null,
      verified: true,
      text: `\`${worker.executable}\` was not found on this ${os} computer. Install ${worker.label} by running \`${command}\` in ${where} (it needs ${node}), then check again.`,
    };
  }
  return {
    platform,
    binary: worker.executable,
    command: null,
    url: worker.install.url,
    verified: false,
    text: `\`${worker.executable}\` was not found on this ${os} computer. ${worker.label} is not published on npm, so there is no install command to offer; its repository is ${worker.install.url} (unverified: nothing here has confirmed that page hosts a release for ${os}). Once it is installed and on PATH — or its full path is given above — check again.`,
  };
}

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

/** Beside the host's other data, so packaging changes nothing here. */
export function buildWorkerSettingsFile(): string {
  return join(dataDirectory(), "build-worker.json");
}

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

/** The chosen kind for a settings value; the default when the id is unknown. */
export function workerKind(id: string): BuildWorkerKind {
  return BUILD_WORKERS.find((entry) => entry.id === id) ?? BUILD_WORKERS[0]!;
}

/**
 * Resolves the chosen worker. The executable is, in order, the environment's
 * override (what a smoke uses to stand in a worker), the path saved in
 * Settings, or the worker's own name on PATH.
 */
export async function buildWorker(): Promise<BuildWorker> {
  const settings = await buildWorkerSettings();
  const kind = workerKind(settings.worker);
  const override = process.env.SOLUTIONS_BUILDER_WORKER_BIN?.trim();
  return { ...kind, command: override || settings.executable || kind.executable };
}
