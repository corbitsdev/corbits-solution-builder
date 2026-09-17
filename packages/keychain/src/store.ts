/**
 * Secure storage used only by the hub's two at-rest encryption keys.
 *
 * Secrets go to the OS keychain through `security(1)` on macOS. Where no
 * OS-backed store is available this falls back to a file with 0600
 * permissions inside the application data directory and *says so* — a
 * fallback that pretends to be a keychain is worse than one that admits
 * what it is.
 *
 * Account names and the service id match the host's historical store so a
 * key minted before this package existed still reads. Owner passwords,
 * hub tokens, and the repo-signing seed stay in `apps/hub` — this module
 * is not their home.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICE = "com.corbits.solutions-builder";

export type CredentialBackend = "keychain" | "file";

let backend: CredentialBackend | null = null;

/**
 * Whether this process is a test/smoke run, not a real launch. Only under
 * this condition does `detectBackend` honour
 * `SOLUTIONS_BUILDER_CREDENTIAL_BACKEND` at all — the override exists so a
 * smoke does not touch the real machine keychain with the production
 * account names, and a real launch that somehow inherited the variable
 * from its environment must not have its keychain silently downgraded to
 * a file because of it.
 */
function isTestRun(): boolean {
  return process.env.SOLUTIONS_BUILDER_SMOKE === "1" || process.env.NODE_ENV === "test";
}

function dataDirectory(): string {
  const override = process.env.SOLUTIONS_BUILDER_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "SolutionsBuilder");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "SolutionsBuilder");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "SolutionsBuilder");
}

async function detectBackend(): Promise<CredentialBackend> {
  if (backend) return backend;
  const forced = process.env.SOLUTIONS_BUILDER_CREDENTIAL_BACKEND;
  if ((forced === "file" || forced === "keychain") && isTestRun()) {
    backend = forced;
    return backend;
  }
  if (forced && !isTestRun()) {
    console.warn(
      `[keychain] SOLUTIONS_BUILDER_CREDENTIAL_BACKEND=${forced} is set but this is not a ` +
        "recognized test run (SOLUTIONS_BUILDER_SMOKE=1 or NODE_ENV=test), so it is being ignored " +
        "and the real backend is being detected instead.",
    );
  }
  if (process.platform === "darwin") {
    const probe = Bun.spawnSync(["security", "-h"], { stdout: "ignore", stderr: "ignore" });
    backend = probe.exitCode === 0 ? "keychain" : "file";
  } else {
    backend = "file";
  }
  return backend;
}

export async function secretReference(account: string): Promise<string> {
  return `${await detectBackend()}:${account}`;
}

function fallbackPath(account: string) {
  return join(dataDirectory(), "credentials", `${encodeURIComponent(account)}.secret`);
}

export async function storeSecret(account: string, secret: string): Promise<string> {
  if ((await detectBackend()) === "keychain") {
    const result = Bun.spawnSync(
      ["security", "add-generic-password", "-U", "-a", account, "-s", SERVICE, "-w", secret],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not write to the keychain: ${result.stderr.toString().trim()}`);
    }
    return `keychain:${account}`;
  }

  const path = fallbackPath(account);
  await mkdir(join(dataDirectory(), "credentials"), { recursive: true, mode: 0o700 });
  await writeFile(path, secret, { mode: 0o600 });
  await chmod(path, 0o600);
  return `file:${account}`;
}

export type SecretRead =
  | { readonly status: "found"; readonly secret: string }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly detail: string };

/**
 * `security find-generic-password` exits 44 for an item that is not there.
 * Every other non-zero exit is a failure to answer: locked, denied, or the
 * tool itself unhappy.
 */
export function classifySecurityExit(exitCode: number, stderr: string): SecretRead | null {
  if (exitCode === 0) return null;
  if (exitCode === 44) return { status: "missing" };
  return {
    status: "unavailable",
    detail: stderr.trim() || `the keychain returned exit code ${exitCode}`,
  };
}

export async function readSecretResult(reference: string): Promise<SecretRead> {
  const [kind, account] = splitReference(reference);
  if (kind === "keychain") {
    const result = Bun.spawnSync(
      ["security", "find-generic-password", "-a", account, "-s", SERVICE, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const problem = classifySecurityExit(result.exitCode, result.stderr.toString());
    if (problem) return problem;
    return { status: "found", secret: result.stdout.toString().trimEnd() };
  }
  const contents = await readFile(fallbackPath(account), "utf8").catch((cause: unknown) => cause);
  if (typeof contents === "string") return { status: "found", secret: contents };
  const code = (contents as { code?: string }).code;
  return code === "ENOENT"
    ? { status: "missing" }
    : { status: "unavailable", detail: String((contents as Error).message ?? contents) };
}

function splitReference(reference: string): [string, string] {
  const separator = reference.indexOf(":");
  if (separator < 0) throw new Error(`Malformed credential reference: ${reference}`);
  return [reference.slice(0, separator), reference.slice(separator + 1)];
}
