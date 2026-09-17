/**
 * Secure storage for the hub's own bootstrap secrets.
 *
 * Secrets go to the OS keychain through `security(1)` on macOS. Where no
 * OS-backed store is available the host falls back to a file with 0600
 * permissions inside the application data directory and *says so* — a fallback
 * that pretends to be a keychain is worse than one that admits what it is.
 *
 * This is not where a *provider* credential lives (CL-8076 moved those into
 * Interchange's own `credential` table, sealed with its own credential cipher,
 * so delegation and the hub's own resolution govern them the same way a
 * deployed workflow's do). What stays here is genuinely circular otherwise:
 * the hub's own at-rest encryption keys (`hub-keys.ts`), and the owner's
 * mint-once password and a hosted hub's bearer token (`hub-client.ts`) —
 * secrets that cannot themselves live in a row this store's own key would
 * have to decrypt.
 *
 * `credential-migration.ts` is the one other caller, and only once: reading
 * whatever a pre-CL-8076 install left behind in the old `provider:<id>` /
 * `oauth:<id>` accounts so it can be carried into the hub's own credential
 * store and deleted from here.
 */
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";

const SERVICE = "com.corbits.solutions-builder";

export type CredentialBackend = "keychain" | "file";

let backend: CredentialBackend | null = null;

async function detectBackend(): Promise<CredentialBackend> {
  if (backend) return backend;
  // A test run forces `file`: the account names this module and
  // `credential-migration.ts` use are real production names
  // (`provider:anthropic`, `oauth:codex-oauth`, ...), and the real macOS
  // keychain is one per machine, not per test run — a smoke that hit it for
  // real could read, or worse overwrite and delete, a developer's own signed-in
  // credentials. `scripts/smoke-env.ts` sets this for every in-process smoke.
  const forced = process.env.SOLUTIONS_BUILDER_CREDENTIAL_BACKEND;
  if (forced === "file" || forced === "keychain") {
    backend = forced;
    return backend;
  }
  if (process.platform === "darwin") {
    const probe = Bun.spawnSync(["security", "-h"], { stdout: "ignore", stderr: "ignore" });
    backend = probe.exitCode === 0 ? "keychain" : "file";
  } else {
    backend = "file";
  }
  return backend;
}

export async function credentialBackend(): Promise<CredentialBackend> {
  return detectBackend();
}

/**
 * The reference `storeSecret` would return for this account. Readers build
 * their reference from this rather than assuming the keychain: on a machine
 * without one the store is a file, and a hardcoded `keychain:` reference reads
 * a secret the host itself wrote as "unavailable".
 */
export async function secretReference(account: string): Promise<string> {
  return `${await detectBackend()}:${account}`;
}

function fallbackPath(account: string) {
  return join(dataDirectory(), "credentials", `${encodeURIComponent(account)}.secret`);
}

export async function storeSecret(account: string, secret: string): Promise<string> {
  if ((await detectBackend()) === "keychain") {
    // `-U` updates in place so reconnecting does not leave a stale entry.
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

/**
 * The three answers a secret store can give, kept apart.
 *
 * "Nothing is stored" and "I could not tell you" are different facts, and
 * collapsing them into `null` is how a locked keychain, or one prompt someone
 * clicked Deny on, reads as first run — after which a caller mints a fresh key
 * over the good one and everything sealed under it is gone.
 */
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

export async function deleteSecret(reference: string): Promise<void> {
  const [kind, account] = splitReference(reference);
  if (kind === "keychain") {
    Bun.spawnSync(["security", "delete-generic-password", "-a", account, "-s", SERVICE], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  await unlink(fallbackPath(account)).catch(() => undefined);
}

function splitReference(reference: string): [string, string] {
  const separator = reference.indexOf(":");
  if (separator < 0) throw new Error(`Malformed credential reference: ${reference}`);
  return [reference.slice(0, separator), reference.slice(separator + 1)];
}
