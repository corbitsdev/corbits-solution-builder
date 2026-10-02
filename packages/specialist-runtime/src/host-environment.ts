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
