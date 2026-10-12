import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostIdentity, initHost } from "./identity.js";
import {
  applyNetworkAccess,
  DEFAULT_NETWORK_ACCESS,
  lanAddresses,
  networkAccessFile,
  networkAccessStatus,
  readNetworkAccess,
  registerLanListener,
  saveNetworkAccess,
  setNetworkAccess,
  type LanListener,
} from "./network-access.ts";

let root = "";
let dataDirVariable = "";
let previousDataDir: string | undefined;

/** The whole suite runs in one process, so another file may have declared
 *  the identity, or configured the keychain on its own, already. The
 *  identity is declared before `initHost` configures the keychain, so a
 *  keychain refusal still leaves it declared; whichever identity stands,
 *  its data-directory variable is pointed here. */
function identityPrefix(): string {
  try {
    return hostIdentity().envPrefix;
  } catch {
    try {
      initHost(TEST_IDENTITY);
    } catch {
      // The keychain was configured by another file; the identity is declared.
    }
    return hostIdentity().envPrefix;
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "network-access-"));
  dataDirVariable = `${identityPrefix()}_DATA_DIR`;
  previousDataDir = process.env[dataDirVariable];
  process.env[dataDirVariable] = root;
});

const TEST_IDENTITY: Parameters<typeof initHost>[0] = {
    appDir: "NetworkTest",
    displayName: "Network test",
    envPrefix: "NETWORK_TEST",
    keychainService: "network-test",
    oauthPageCopy: { productName: "Network test", siteUrl: "https://example.test", siteLabel: "example.test", githubUrl: "https://example.test", githubLabel: "example.test" },
    notificationSender: "network-test",
    sessionCookie: "network_test_session",
    handshakePrefix: "Network test launch URL: ",
    hubConfigScriptId: "network-test-config",
    globalTokenKey: "networkTestToken",
    connectSrcExtra: [],
    interfaceBuildHint: "bun run ui:build",
    ownerEmail: "owner@network.test",
    ownerName: "You",
    workspaceSlug: "network-test",
    legacyTenantId: "t_local",
};

afterAll(async () => {
  registerLanListener(null);
  if (previousDataDir === undefined) delete process.env[dataDirVariable];
  else process.env[dataDirVariable] = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

/** A listener that records what it was asked, binding `bound` for a start. */
function fakeListener(bound: (asked: number) => number): LanListener & { calls: string[] } {
  let port: number | null = null;
  const calls: string[] = [];
  return {
    calls,
    async start(asked) {
      calls.push(`start:${String(asked)}`);
      port = bound(asked);
      return port;
    },
    async stop() {
      calls.push("stop");
      port = null;
    },
    port: () => port,
    launchUrl: (host, on) => `http://${host}:${String(on)}/?token=tok`,
  };
}

describe("network access settings", () => {
  test("off by default, read back as saved, and the file sits beside the host's data", async () => {
    expect(networkAccessFile()).toBe(join(root, "network.json"));
    expect(await readNetworkAccess()).toEqual(DEFAULT_NETWORK_ACCESS);
    expect(await saveNetworkAccess({ lan: true })).toEqual({ lan: true, lanPort: 0 });
    expect(JSON.parse(await readFile(networkAccessFile(), "utf8"))).toEqual({ lan: true, lanPort: 0 });
    expect(await saveNetworkAccess({ lanPort: 40123 })).toEqual({ lan: true, lanPort: 40123 });
    await saveNetworkAccess({ lan: false });
  });

  test("a value the type rejects is refused and nothing is written", async () => {
    await expect(saveNetworkAccess({ lanPort: 70000 })).rejects.toThrow("port number");
    await expect(saveNetworkAccess({ lan: "yes" as unknown as boolean })).rejects.toThrow("true or false");
    expect(await readNetworkAccess()).toEqual({ lan: false, lanPort: 40123 });
  });
});

describe("lanAddresses", () => {
  test("every interface's IPv4 address but loopback, once each, in order", () => {
    const interfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
      en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
      bridge: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
    } as unknown as Parameters<typeof lanAddresses>[0];
    expect(lanAddresses(interfaces)).toEqual(["10.0.0.5", "192.168.1.20"]);
    expect(lanAddresses({})).toEqual([]);
  });
});

describe("applying the setting to the listener", () => {
  test("on brings the listener up on the remembered port, and the port it bound is remembered", async () => {
    const listener = fakeListener((asked) => (asked === 40123 ? 40124 : asked));
    registerLanListener(listener);
    await saveNetworkAccess({ lan: true, lanPort: 40123 });
    const status = await applyNetworkAccess();
    expect(listener.calls).toEqual(["start:40123"]);
    expect(status.lan).toBe(true);
    expect(status.port).toBe(40124);
    expect((await readNetworkAccess()).lanPort).toBe(40124);
    // Already up: nothing more is started.
    await applyNetworkAccess();
    expect(listener.calls).toEqual(["start:40123"]);
    for (const entry of status.addresses) expect(entry.url).toBe(`http://${entry.address}:40124/?token=tok`);
  });

  test("off brings it down, and the status says so with no addresses", async () => {
    const listener = fakeListener((asked) => asked || 5000);
    registerLanListener(listener);
    await listener.start(40124);
    const status = await setNetworkAccess({ lan: false });
    expect(listener.calls).toEqual(["start:40124", "stop"]);
    expect(status).toEqual({ lan: false, port: null, addresses: [] });
  });

  test("a listener that cannot start leaves the setting off, and the failure is the answer", async () => {
    registerLanListener({
      async start() {
        throw new Error("EACCES");
      },
      async stop() {},
      port: () => null,
      launchUrl: () => "",
    });
    await expect(setNetworkAccess({ lan: true })).rejects.toThrow("could not listen on the network: EACCES");
    expect((await readNetworkAccess()).lan).toBe(false);
  });

  test("without a listener registered the setting is only remembered", async () => {
    registerLanListener(null);
    const status = await setNetworkAccess({ lan: true });
    expect(status).toEqual({ lan: true, port: null, addresses: [] });
    await setNetworkAccess({ lan: false });
  });
});
