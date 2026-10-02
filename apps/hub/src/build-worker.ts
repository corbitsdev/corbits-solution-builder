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
 * the source it names was seen to exist: an npm package `npm view`
 * answered for, or a release and a Homebrew tap that were read.
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
  /**
   * How one attempt's prompt reaches the worker, and the arguments that
   * run it and end. Never as one argument: a packet of a plan, requirements
   * and a design runs past the 128 KiB a single argument may be on Linux
   * (E2BIG). `stdin` writes the packet to the worker's standard input;
   * `file` writes it to `path` under the working directory and names it in
   * a short prompt. Never a permission-skipping flag.
   */
  readonly prompt: { readonly via: "stdin"; readonly args: readonly string[] } | { readonly via: "file"; readonly path: string; readonly args: readonly string[] };
  /**
   * The host's environment variables this worker needs for its own sign-in
   * and configuration, by name or by `PREFIX_*`. Nothing else of the host's
   * environment reaches it (`@solutions-builder/specialist-runtime/host-environment`).
   */
  readonly environment: readonly string[];
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
 * How a worker is obtained. `npm` names a package `npm view` answered for.
 * `release` names a Homebrew formula (macOS and Linux) and the GitHub
 * releases page that carries the tarballs and Debian packages; no Windows
 * build is published there.
 */
export type WorkerInstall =
  | { readonly kind: "npm"; readonly package: string }
  | { readonly kind: "release"; readonly brew: string; readonly releases: string; readonly deb: boolean };

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
    // `corbits exec` takes its prompt as a positional and reads none from
    // stdin, so the packet is a file in the hook directory the bridge
    // already places (never shipped: `.corbits` is excluded from the
    // archive and from a continued copy) and the prompt names it.
    prompt: {
      via: "file",
      path: ".corbits/solution-builder-prompt.md",
      args: ["exec", "Read the file .corbits/solution-builder-prompt.md in the current directory and do exactly what it says. It is the approved build packet: the plan, the requirements it cites, the design and the frozen stack."],
    },
    environment: ["CORBITS_*"],
    turnReports: { install: corbitsTurnHook },
    // Not on npm, and not meant to be: a binary from GitHub releases
    // (macOS and Linux tarballs, Debian packages; no Windows build) and the
    // `corbits-code` formula in the corbitsdev/homebrew-tap tap.
    install: { kind: "release", brew: "corbitsdev/tap/corbits-code", releases: "https://github.com/corbitsdev/corbits-code/releases/latest", deb: true },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    executable: "claude",
    probe: ["--version"],
    probeExpects: null,
    // `claude -p` with no prompt argument reads the prompt from stdin.
    prompt: { via: "stdin", args: ["-p"] },
    environment: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
    turnReports: null,
    install: { kind: "npm", package: "@anthropic-ai/claude-code" },
  },
  {
    id: "codex",
    label: "Codex",
    executable: "codex",
    probe: ["--version"],
    probeExpects: null,
    // `codex exec -` reads the prompt from stdin.
    prompt: { via: "stdin", args: ["exec", "-"] },
    environment: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
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
  /** A page to read as well, or instead where no command is known. */
  readonly url: string | null;
  /** False only for a pointer that was never confirmed to host an installable release; none today. */
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
  const { brew, releases, deb } = worker.install;
  const command = platform === "windows" ? null : `brew install ${brew}`;
  const text =
    platform === "macos"
      ? `\`${worker.executable}\` was not found on this macOS computer. Install ${worker.label} with Homebrew by running \`${command}\` in a terminal, or download the macOS tarball (arm64 or x64) from ${releases}, unpack it and put \`${worker.executable}\` on PATH. Then check again.`
      : platform === "linux"
        ? `\`${worker.executable}\` was not found on this Linux computer. Install ${worker.label} with Homebrew by running \`${command}\` in a terminal${deb ? `, or on Debian or Ubuntu download the .deb from ${releases} and run \`sudo dpkg -i corbits_<version>_<arch>.deb\`` : ""}, or download the Linux tarball (arm64 or x64) from the same page, unpack it and put \`${worker.executable}\` on PATH. Then check again.`
        : `\`${worker.executable}\` was not found on this Windows computer, and ${worker.label} is not published for Windows: ${releases} carries macOS and Linux builds only. Choose Claude Code or Codex here, or run the host on macOS or Linux.`;
  return { platform, binary: worker.executable, command, url: releases, verified: true, text };
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
