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

function secretPath(dataDir: string, account: string): string {
  return join(dataDir, "credentials", `${encodeURIComponent(account)}.secret`);
}

describe("hubEncryptionKeys", () => {
  const previous = {
    dataDir: process.env.SOLUTIONS_BUILDER_DATA_DIR,
    credential: process.env.CREDENTIAL_ENCRYPTION_KEY,
    principal: process.env.PRINCIPAL_KEY_ENCRYPTION_KEY,
  };
  const dirs: string[] = [];

  afterEach(async () => {
    if (previous.dataDir === undefined) delete process.env.SOLUTIONS_BUILDER_DATA_DIR;
    else process.env.SOLUTIONS_BUILDER_DATA_DIR = previous.dataDir;
    if (previous.credential === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = previous.credential;
    if (previous.principal === undefined) delete process.env.PRINCIPAL_KEY_ENCRYPTION_KEY;
    else process.env.PRINCIPAL_KEY_ENCRYPTION_KEY = previous.principal;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("environment variables win when set, even if the store already has keys", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "keychain-env-"));
    dirs.push(dataDir);
    process.env.SOLUTIONS_BUILDER_DATA_DIR = dataDir;
    await mkdir(join(dataDir, "credentials"), { recursive: true, mode: 0o700 });
    await Bun.write(secretPath(dataDir, CREDENTIAL_ACCOUNT), "a".repeat(64));
    await Bun.write(secretPath(dataDir, PRINCIPAL_ACCOUNT), "b".repeat(64));
    process.env.CREDENTIAL_ENCRYPTION_KEY = "c".repeat(64);
    process.env.PRINCIPAL_KEY_ENCRYPTION_KEY = "d".repeat(64);

    const keys = await hubEncryptionKeys();

    expect(keys.credentialKeyHex).toBe("c".repeat(64));
    expect(keys.principalKeyHex).toBe("d".repeat(64));
    expect(await readFile(secretPath(dataDir, CREDENTIAL_ACCOUNT), "utf8")).toBe("a".repeat(64));
    expect(await readFile(secretPath(dataDir, PRINCIPAL_ACCOUNT), "utf8")).toBe("b".repeat(64));
  });

  test("mints and stores 64-hex keys when unset, then reuses them", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "keychain-mint-"));
    dirs.push(dataDir);
    process.env.SOLUTIONS_BUILDER_DATA_DIR = dataDir;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.PRINCIPAL_KEY_ENCRYPTION_KEY;

    const first = await hubEncryptionKeys();
    expect(first.credentialKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.principalKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(first.credentialKeyHex).not.toBe(first.principalKeyHex);
    expect(await readFile(secretPath(dataDir, CREDENTIAL_ACCOUNT), "utf8")).toBe(first.credentialKeyHex);
    expect(await readFile(secretPath(dataDir, PRINCIPAL_ACCOUNT), "utf8")).toBe(first.principalKeyHex);

    const second = await hubEncryptionKeys();
    expect(second).toEqual(first);
  });
});
