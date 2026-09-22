/**
 * Secure storage primitives shared by the hub's two at-rest encryption keys
 * and the host's own bootstrap secrets (owner password, hub token,
 * repo-signing seed — see `packages/embedded-host/src/host-secrets.ts`).
 *
 * Secrets go to the OS keychain through `security(1)` on macOS. Where no
 * OS-backed store is available this falls back to a file with 0600
 * permissions inside the application data directory and *says so* — a
 * fallback that pretends to be a keychain is worse than one that admits
 * what it is.
 *
 * Account names and the service id match the host's historical store so a
 * key minted before this package existed still reads.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What makes this store this product's. `service` is the `security -s`
 * name items live under — changing it orphans every secret minted before
 * the change, so a product picks one and keeps it. `dataDirectory` is a
 * resolver, not a string, so a `<envPrefix>_DATA_DIR` override (or a test's
 * per-case temp dir) keeps working after configuration.
 */
export interface KeychainConfig {
  readonly service: string;
  readonly dataDirectory: () => string;
  readonly envPrefix: string;
}

let config: KeychainConfig | null = null;

export function configureKeychain(next: KeychainConfig): void {
  if (config) throw new Error("configureKeychain has already run for this process.");
  config = next;
}

function keychainConfig(): KeychainConfig {
  if (!config) {
    throw new Error("configureKeychain has not run — the entrypoint declares the keychain config first.");
  }
  return config;
}

export type CredentialBackend = "keychain" | "file";

let backend: CredentialBackend | null = null;

/**
 * Whether this process is a test/smoke run, not a real launch. Only under
 * this condition does `detectBackend` honour
 * `<envPrefix>_CREDENTIAL_BACKEND` at all — the override exists so a
 * smoke does not touch the real machine keychain with the production
 * account names, and a real launch that somehow inherited the variable
 * from its environment must not have its keychain silently downgraded to
 * a file because of it.
 */
function isTestRun(envPrefix: string): boolean {
  return process.env[`${envPrefix}_SMOKE`] === "1" || process.env.NODE_ENV === "test";
}

async function detectBackend(): Promise<CredentialBackend> {
  if (backend) return backend;
  const { envPrefix } = keychainConfig();
  const backendEnv = `${envPrefix}_CREDENTIAL_BACKEND`;
  const forced = process.env[backendEnv];
  if ((forced === "file" || forced === "keychain") && isTestRun(envPrefix)) {
    backend = forced;
    return backend;
  }
  if (forced && !isTestRun(envPrefix)) {
    console.warn(
      `[keychain] ${backendEnv}=${forced} is set but this is not a ` +
        `recognized test run (${envPrefix}_SMOKE=1 or NODE_ENV=test), so it is being ignored ` +
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

export async function secretReference(account: string): Promise<string> {
  return `${await detectBackend()}:${account}`;
}

function fallbackPath(account: string) {
  return join(keychainConfig().dataDirectory(), "credentials", `${encodeURIComponent(account)}.secret`);
}

export async function storeSecret(account: string, secret: string): Promise<string> {
  if ((await detectBackend()) === "keychain") {
    const result = Bun.spawnSync(
      ["security", "add-generic-password", "-U", "-a", account, "-s", keychainConfig().service, "-w", secret],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not write to the keychain: ${result.stderr.toString().trim()}`);
    }
    return `keychain:${account}`;
  }

  const path = fallbackPath(account);
  await mkdir(join(keychainConfig().dataDirectory(), "credentials"), { recursive: true, mode: 0o700 });
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
      ["security", "find-generic-password", "-a", account, "-s", keychainConfig().service, "-w"],
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
