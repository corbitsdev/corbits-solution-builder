/**
 * The environment a process the host starts on a person's behalf inherits:
 * a build worker, or a delivery target started to be probed.
 *
 * Nothing of the host's own environment reaches such a process unless it is
 * named here. The host's process carries the hub's secrets (a credential
 * encryption key, a repo signing key, the sidecar adapter manifest) and
 * whatever the shell that launched it exported; a worker that inherited all
 * of that could read, log or ship it. So only what a program needs to run
 * at all is passed — where binaries and the home directory are, the locale,
 * the temp directory, the terminal — plus the variables a worker names for
 * its own sign-in. The same rule the sidecar provisioner keeps
 * (`packages/embed-hub/src/process-provisioner.ts`).
 */
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";

/** What any process needs to run at all. `LC_*` is matched by prefix. */
const BASE_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  // Windows: where the system, the profile and the temp directory are.
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

const BASE_PREFIXES: readonly string[] = ["LC_"];

/**
 * The allowlisted subset of `host` (the process's own environment by
 * default), plus the `named` variables, when set. A name ending in `*`
 * admits every variable with that prefix.
 */
export function inheritedEnvironment(named: readonly string[] = [], host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = new Set<string>();
  const prefixes = [...BASE_PREFIXES];
  for (const entry of named) {
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else names.add(entry);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined || value === "") continue;
    const upper = process.platform === "win32" ? key.toUpperCase() : key;
    if (names.has(upper) || BASE_NAMES.includes(upper) || prefixes.some((prefix) => upper.startsWith(prefix))) env[key] = value;
  }
  return env;
}

/** The toolchain directories under the home directory a confined command may read: each `PATH` entry there, and a `bin` entry's own install root (`~/.bun`, `~/.nvm/versions/node/<v>`), where a runtime keeps its libraries. Never the home directory itself, nor `~/.local`, which holds other programs' data. */
async function toolchainUnder(home: string, path: string): Promise<string[]> {
  const shared = new Set([home, join(home, ".local")]);
  const dirs = new Set<string>();
  for (const entry of path.split(delimiter)) {
    if (!isAbsolute(entry)) continue;
    let real: string;
    try {
      real = await realpath(entry);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    if (!real.startsWith(`${home}${sep}`)) continue;
    dirs.add(real);
    if (basename(real) === "bin" && !shared.has(dirname(real))) dirs.add(dirname(real));
  }
  return [...dirs];
}

const sbplString = (path: string) => JSON.stringify(path);

/**
 * Network: this machine only. Writes: the attempt directory, and the
 * terminal and null devices. Reads: anywhere but the home directory, where
 * only the attempt directory and the toolchain are readable, and their
 * ancestors may be stat'ed, never listed: resolving a real path walks them.
 * Later rules win.
 */
function attemptProfile(attempt: string, home: string, toolchain: readonly string[]): string {
  const readable = [attempt, ...toolchain];
  const ancestors = new Set<string>();
  for (const dir of readable) {
    for (let up = dirname(dir); up === home || up.startsWith(`${home}${sep}`); up = dirname(up)) ancestors.add(up);
  }
  return [
    "(version 1)(allow default)",
    '(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))',
    `(deny file-write*)(allow file-write* (subpath ${sbplString(attempt)}) (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/tty"))`,
    `(deny file-read* (subpath ${sbplString(home)}))`,
    `(allow file-read* ${readable.map((dir) => `(subpath ${sbplString(dir)})`).join(" ")})`,
    // An allow with no filter would allow every path.
    ancestors.size === 0 ? "" : `(allow file-read-metadata ${[...ancestors].map((dir) => `(literal ${sbplString(dir)})`).join(" ")})`,
  ].join("");
}

export type Confined = {
  readonly command: string[];
  /** Set over everything else the process is given: its home and temp directory, both inside `scratch`. */
  readonly env: Record<string, string>;
  /** Inside the attempt directory; the caller removes it once the process has ended. */
  readonly scratch: string;
};

/**
 * `command` confined to the attempt directory `dir`, where the platform can
 * confine it: macOS's `sandbox-exec`. Its home and temp directory are a
 * fresh scratch directory inside the attempt, so a tool's caches and
 * dotfiles are its own. Elsewhere there is no confinement and the command
 * must not run; the reason is returned for the caller to record.
 */
export async function confinedToAttempt(command: readonly string[], dir: string): Promise<Confined | string> {
  if (process.platform !== "darwin") return `no confinement on ${process.platform}`;
  const attempt = await realpath(dir);
  const home = await realpath(homedir());
  await mkdir(join(attempt, ".solutions-builder"), { recursive: true });
  const scratch = await mkdtemp(join(attempt, ".solutions-builder", "run-"));
  await Promise.all([mkdir(join(scratch, "home")), mkdir(join(scratch, "tmp"))]);
  const profile = attemptProfile(attempt, home, await toolchainUnder(home, process.env.PATH ?? ""));
  return {
    command: ["/usr/bin/sandbox-exec", "-p", profile, ...command],
    env: { HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp") },
    scratch,
  };
}

/** The transcript's line for what a started process could reach. */
export const CONFINEMENT_LINE =
  "confined (sandbox-exec): network to this machine only; writes only inside the attempt directory; nothing in the home directory readable but the attempt directory and the toolchain.";
