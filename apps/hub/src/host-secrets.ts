/**
 * Secure storage for the hub's own bootstrap secrets.
 *
 * Secrets go to the OS keychain through `security(1)` on macOS. Where no
 * OS-backed store is available the host falls back to a file with 0600
 * permissions inside the application data directory and *says so* — a fallback
 * that pretends to be a keychain is worse than one that admits what it is.
 *
 * This is not where a *provider* credential lives — those are Interchange's
 * own `credential` table rows, sealed with its own credential cipher, so
 * delegation and the hub's own resolution govern them the same way a
 * deployed workflow's do. What stays here is genuinely circular otherwise:
 * the owner's mint-once password and a hosted hub's bearer token
 * (`hub-client.ts`), plus the hub's repo-signing seed (`hub-keys.ts`) —
 * secrets that cannot themselves live in a row the encryption keys would
 * have to decrypt. The two Interchange at-rest encryption keys live in
 * `@solutions-builder/keychain`.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";

const SERVICE = "com.corbits.solutions-builder";

export type CredentialBackend = "keychain" | "file";

let backend: CredentialBackend | null = null;

/**
 * Whether this process is a test/smoke run, not a real launch. Only under
 * this condition does `detectBackend` honour
 * `SOLUTIONS_BUILDER_CREDENTIAL_BACKEND` at all — the override exists so a
 * smoke does not touch the real machine keychain with the production account
 * names this module and `credential-migration.ts` use, and a real launch that
 * somehow inherited the variable from its environment must not have its
 * keychain silently downgraded to a file because of it.
 */
function isTestRun(): boolean {
  return process.env.SOLUTIONS_BUILDER_SMOKE === "1" || process.env.NODE_ENV === "test";
}

async function detectBackend(): Promise<CredentialBackend> {
  if (backend) return backend;
  const forced = process.env.SOLUTIONS_BUILDER_CREDENTIAL_BACKEND;
  if ((forced === "file" || forced === "keychain") && isTestRun()) {
    backend = forced;
    return backend;
  }
  if (forced && !isTestRun()) {
    // Said loudly rather than silently honoured or silently ignored: either
    // a real launch's environment carries a variable meant only for tests
    // (worth knowing), or a test run forgot to set the marker (worth fixing).
    console.warn(
      `[host-secrets] SOLUTIONS_BUILDER_CREDENTIAL_BACKEND=${forced} is set but this is not a ` +
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
function classifySecurityExit(exitCode: number, stderr: string): SecretRead | null {
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
