import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostIdentity, initHost } from "./identity.js";
import {
  applyNetworkAccess,
  DEFAULT_NETWORK_ACCESS,
  ensureNetworkCertificate,
  lanAddresses,
  networkAccessFile,
  networkCertificateFiles,
  networkAccessStatus,
  readNetworkAccess,
  registerLanListener,
  saveNetworkAccess,
  setNetworkAccess,
  type LanListener,
  type NetworkCertificate,
  type OpensslRunner,
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

/** Stands in for openssl: writes a cert and key where asked, prints a fingerprint. */
let minted = 0;
const fakeOpenssl: OpensslRunner = async (args) => {
  if (args[0] === "req") {
    minted += 1;
    await writeFile(args[args.indexOf("-keyout") + 1]!, `KEY ${String(minted)}\n`);
    await writeFile(args[args.indexOf("-out") + 1]!, `CERT ${String(minted)}\n`);
    return "";
  }
  if (args[0] === "x509") return `SHA256 Fingerprint=aa:bb:${String(minted).padStart(2, "0")}\n`;
  throw new Error(`unexpected openssl ${args.join(" ")}`);
};

/** A listener that records what it was asked, binding `bound` for a start. */
function fakeListener(bound: (asked: number) => number): LanListener & { calls: string[]; served: NetworkCertificate | null } {
  let port: number | null = null;
  const calls: string[] = [];
  const self = {
    calls,
    served: null as NetworkCertificate | null,
    async start(asked: number, certificate: NetworkCertificate) {
      calls.push(`start:${String(asked)}`);
      self.served = certificate;
      port = bound(asked);
      return port;
    },
    async stop() {
      calls.push("stop");
      port = null;
    },
    port: () => port,
    launchUrl: (host: string, on: number) => `https://${host}:${String(on)}/?token=tok`,
  };
  return self;
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

describe("the network certificate", () => {
  test("minted once for this computer's addresses and loopback, read back while they hold, minted again when they change", async () => {
    const first = await ensureNetworkCertificate(["192.168.1.20", "10.0.0.5"], fakeOpenssl);
    expect(first.addresses).toEqual(["10.0.0.5", "127.0.0.1", "192.168.1.20"]);
    expect(first.cert).toBe("CERT 1\n");
    expect(first.fingerprint).toBe("AA:BB:01");
    const files = networkCertificateFiles();
    expect(JSON.parse(await readFile(files.meta, "utf8")).addresses).toEqual(first.addresses);
    // The same addresses in another order: the certificate on disk.
    const again = await ensureNetworkCertificate(["10.0.0.5", "192.168.1.20"], fakeOpenssl);
    expect(again).toEqual(first);
    const moved = await ensureNetworkCertificate(["172.16.0.9"], fakeOpenssl);
    expect(moved.cert).toBe("CERT 2\n");
    expect(moved.addresses).toEqual(["127.0.0.1", "172.16.0.9"]);
  });

  test("the real openssl mints a certificate naming the addresses, when it is on this computer", async () => {
    if (!Bun.which("openssl")) return;
    const certificate = await ensureNetworkCertificate(["203.0.113.7"]);
    expect(certificate.cert).toContain("BEGIN CERTIFICATE");
    expect(certificate.key).toContain("PRIVATE KEY");
    expect(certificate.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const text = Bun.spawnSync(["openssl", "x509", "-in", networkCertificateFiles().cert, "-noout", "-text"]).stdout.toString();
    expect(text).toContain("IP Address:203.0.113.7");
    expect(text).toContain("IP Address:127.0.0.1");
  });
});

describe("applying the setting to the listener", () => {
  test("on brings the listener up on the remembered port with a certificate, and the port it bound is remembered", async () => {
    const listener = fakeListener((asked) => (asked === 40123 ? 40124 : asked));
    registerLanListener(listener);
    await saveNetworkAccess({ lan: true, lanPort: 40123 });
    const status = await applyNetworkAccess(fakeOpenssl);
    expect(listener.calls).toEqual(["start:40123"]);
    expect(listener.served?.addresses).toEqual([...new Set([...lanAddresses(), "127.0.0.1"])].sort());
    expect(status.lan).toBe(true);
    expect(status.port).toBe(40124);
    expect(status.fingerprint).toBe(listener.served?.fingerprint ?? null);
    expect((await readNetworkAccess()).lanPort).toBe(40124);
    // Already up, same addresses: nothing more is started.
    await applyNetworkAccess(fakeOpenssl);
    expect(listener.calls).toEqual(["start:40123"]);
    for (const entry of status.addresses) expect(entry.url).toBe(`https://${entry.address}:40124/?token=tok`);
  });

  test("off brings it down, and the status says so with no addresses", async () => {
    const listener = fakeListener((asked) => asked || 5000);
    registerLanListener(listener);
    await applyNetworkAccess(fakeOpenssl);
    const status = await setNetworkAccess({ lan: false }, fakeOpenssl);
    expect(listener.calls.at(-1)).toBe("stop");
    expect(status).toEqual({ lan: false, port: null, addresses: [], fingerprint: null });
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
    await expect(setNetworkAccess({ lan: true }, fakeOpenssl)).rejects.toThrow("could not listen on the network: EACCES");
    expect((await readNetworkAccess()).lan).toBe(false);
  });

  test("without a listener registered the setting is only remembered", async () => {
    registerLanListener(null);
    const status = await setNetworkAccess({ lan: true }, fakeOpenssl);
    expect(status).toEqual({ lan: true, port: null, addresses: [], fingerprint: null });
    await setNetworkAccess({ lan: false });
  });
});
