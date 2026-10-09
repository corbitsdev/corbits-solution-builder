process.env.NODE_ENV = "test";
process.env.SOLUTIONS_BUILDER_CREDENTIAL_BACKEND = "file";
process.env.SOLUTIONS_BUILDER_SMOKE = "1";

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { configureKeychain } from "./store.js";
import { hubEncryptionKeys } from "./hub-encryption-keys.js";

// The store is product-agnostic; the test stands in for the entrypoint.
// The resolver reads the env per call because each test swaps the dir.
configureKeychain({
  service: "com.corbits.solutions-builder",
  envPrefix: "SOLUTIONS_BUILDER",
  dataDirectory: () => process.env.SOLUTIONS_BUILDER_DATA_DIR ?? join(tmpdir(), "keychain-test"),
});

const CREDENTIAL_ACCOUNT = "hub:credential-encryption-key";
const PRINCIPAL_ACCOUNT = "hub:principal-key-encryption-key";
const SIDECAR_ACCOUNT = "sidecar:credential-encryption-key";
const ENVIRONMENT = ["CREDENTIAL_ENCRYPTION_KEY", "PRINCIPAL_KEY_ENCRYPTION_KEY", "SIDECAR_CREDENTIAL_ENCRYPTION_KEY"] as const;

function secretPath(dataDir: string, account: string): string {
  return join(dataDir, "credentials", `${encodeURIComponent(account)}.secret`);
}

describe("hubEncryptionKeys", () => {
  const previous = {
    dataDir: process.env.SOLUTIONS_BUILDER_DATA_DIR,
    environment: ENVIRONMENT.map((name) => [name, process.env[name]] as const),
  };
  const dirs: string[] = [];

  afterEach(async () => {
    if (previous.dataDir === undefined) delete process.env.SOLUTIONS_BUILDER_DATA_DIR;
    else process.env.SOLUTIONS_BUILDER_DATA_DIR = previous.dataDir;
    for (const [name, value] of previous.environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function freshDataDir(prefix: string): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dataDir);
    process.env.SOLUTIONS_BUILDER_DATA_DIR = dataDir;
    for (const name of ENVIRONMENT) delete process.env[name];
    return dataDir;
  }

  test("environment variables win when set, even if the store already has keys", async () => {
    const dataDir = await freshDataDir("keychain-env-");
    await mkdir(join(dataDir, "credentials"), { recursive: true, mode: 0o700 });
    await Bun.write(secretPath(dataDir, CREDENTIAL_ACCOUNT), "a".repeat(64));
    await Bun.write(secretPath(dataDir, PRINCIPAL_ACCOUNT), "b".repeat(64));
    await Bun.write(secretPath(dataDir, SIDECAR_ACCOUNT), "e".repeat(64));
    process.env.CREDENTIAL_ENCRYPTION_KEY = "c".repeat(64);
    process.env.PRINCIPAL_KEY_ENCRYPTION_KEY = "d".repeat(64);
    process.env.SIDECAR_CREDENTIAL_ENCRYPTION_KEY = "f".repeat(64);

    const keys = await hubEncryptionKeys();

    expect(keys.credentialKeyHex).toBe("c".repeat(64));
    expect(keys.principalKeyHex).toBe("d".repeat(64));
    expect(keys.sidecarCredentialKeyHex).toBe("f".repeat(64));
    expect(await readFile(secretPath(dataDir, CREDENTIAL_ACCOUNT), "utf8")).toBe("a".repeat(64));
    expect(await readFile(secretPath(dataDir, PRINCIPAL_ACCOUNT), "utf8")).toBe("b".repeat(64));
    expect(await readFile(secretPath(dataDir, SIDECAR_ACCOUNT), "utf8")).toBe("e".repeat(64));
  });

  test("mints and stores 64-hex keys when unset, then reuses them", async () => {
    const dataDir = await freshDataDir("keychain-mint-");

    const first = await hubEncryptionKeys();
    expect(first.credentialKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.principalKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.credentialKeyHex).not.toBe(first.principalKeyHex);
    expect(await readFile(secretPath(dataDir, CREDENTIAL_ACCOUNT), "utf8")).toBe(first.credentialKeyHex);
    expect(await readFile(secretPath(dataDir, PRINCIPAL_ACCOUNT), "utf8")).toBe(first.principalKeyHex);

    const second = await hubEncryptionKeys();
    expect(second).toEqual(first);
  });

  test("gives sidecars a key of their own, stored beside the hub's and the same at the next boot", async () => {
    const dataDir = await freshDataDir("keychain-sidecar-");

    const firstBoot = await hubEncryptionKeys();
    expect(firstBoot.sidecarCredentialKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(firstBoot.sidecarCredentialKeyHex).not.toBe(firstBoot.credentialKeyHex);
    expect(firstBoot.sidecarCredentialKeyHex).not.toBe(firstBoot.principalKeyHex);
    expect(await readFile(secretPath(dataDir, SIDECAR_ACCOUNT), "utf8")).toBe(firstBoot.sidecarCredentialKeyHex);

    const secondBoot = await hubEncryptionKeys();
    expect(secondBoot.sidecarCredentialKeyHex).toBe(firstBoot.sidecarCredentialKeyHex);
  });
});
