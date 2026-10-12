/**
 * Whether the host is reachable from other devices on the local network.
 *
 * The loopback server is the host's own: the window, the port file and the
 * scripts all reach it there, and nothing about it changes. Being on the
 * network is a second listener on every interface, on its own remembered
 * port, serving the same handler (`serve.ts`). It is off until a person
 * turns it on in Settings, starts at launch when the setting says so, and
 * starts or stops live when the setting changes; the session token stays
 * the one credential, carried by the launch link a person opens on the
 * other device (#887).
 *
 * The listener serves TLS (#889): a browser will not hold a plain-http
 * page on a non-loopback address, and such a page is not a secure context
 * anyway, so the app's own `crypto.subtle` would be missing. The host
 * mints a self-signed certificate once, beside its data, naming this
 * computer's addresses, and a new one when those change. The device warns
 * the first time, since this computer issued it; Settings says so and
 * shows the fingerprint to check against.
 */
import { networkInterfaces } from "node:os";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HostError } from "./errors.js";
import { dataDirectory } from "./paths.js";

export type NetworkAccess = {
  /** Listen on every interface, not only loopback. */
  readonly lan: boolean;
  /** The port the network listener took last time, taken again while it is free; 0 until it has had one. */
  readonly lanPort: number;
};

export const DEFAULT_NETWORK_ACCESS: NetworkAccess = { lan: false, lanPort: 0 };

/** Beside the host's other data, so packaging changes nothing here. */
export function networkAccessFile(): string {
  return join(dataDirectory(), "network.json");
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65_535;
}

/** The settings as saved, with defaults for anything missing or unreadable. */
export async function readNetworkAccess(): Promise<NetworkAccess> {
  try {
    const raw = JSON.parse(await readFile(networkAccessFile(), "utf8")) as Partial<Record<keyof NetworkAccess, unknown>>;
    return {
      lan: typeof raw.lan === "boolean" ? raw.lan : DEFAULT_NETWORK_ACCESS.lan,
      lanPort: validPort(raw.lanPort) ? raw.lanPort : DEFAULT_NETWORK_ACCESS.lanPort,
    };
  } catch {
    return DEFAULT_NETWORK_ACCESS;
  }
}

/** Saves are one after another: two in flight at once would each write the other's change away. */
let writing: Promise<unknown> = Promise.resolve();

export function saveNetworkAccess(patch: Partial<NetworkAccess>): Promise<NetworkAccess> {
  const turn = writing.then(() => writeNetworkAccess(patch));
  writing = turn.catch(() => undefined);
  return turn;
}

async function writeNetworkAccess(patch: Partial<NetworkAccess>): Promise<NetworkAccess> {
  if (patch.lan !== undefined && typeof patch.lan !== "boolean") throw new HostError("validation_failed", "Network access: lan must be true or false.");
  if (patch.lanPort !== undefined && !validPort(patch.lanPort)) throw new HostError("validation_failed", "Network access: lanPort must be a port number.");
  const next: NetworkAccess = { ...(await readNetworkAccess()), ...patch };
  const file = networkAccessFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** The machine's own IPv4 addresses on the network, loopback left out, in a stable order. */
export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      found.add(entry.address);
    }
  }
  return [...found].sort();
}

/** The certificate the network listener serves: PEM text, and what it was issued for. */
export type NetworkCertificate = {
  readonly cert: string;
  readonly key: string;
  /** SHA-256 of the certificate, colon-separated hex, as a browser shows it. */
  readonly fingerprint: string;
  /** The addresses it names, sorted. */
  readonly addresses: readonly string[];
};

export function networkCertificateFiles(): { readonly cert: string; readonly key: string; readonly meta: string } {
  const dir = dataDirectory();
  return { cert: join(dir, "network-cert.pem"), key: join(dir, "network-key.pem"), meta: join(dir, "network-cert.json") };
}

/** Ten years: the certificate is this computer's own, trusted by hand on each device. */
const CERTIFICATE_DAYS = 3650;

/** Runs `openssl` with `args`; answers stdout, or throws with stderr. */
export type OpensslRunner = (args: readonly string[]) => Promise<string>;

async function runOpenssl(args: readonly string[]): Promise<string> {
  const binary = Bun.which("openssl");
  if (!binary) throw new HostError("internal_error", "The openssl command is needed to make the network certificate, and it is not on this computer's PATH.");
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new HostError("internal_error", `openssl ${args[0] ?? ""} failed: ${err.trim().split("\n").at(-1) ?? ""}`);
  return out;
}

/** The names a certificate for `addresses` carries: them, and loopback, so the same listener answers both. */
function certificateNames(addresses: readonly string[]): string[] {
  return [...new Set([...addresses, "127.0.0.1"])].sort();
}

/**
 * The certificate for this computer's addresses: the one on disk when it
 * names exactly these, a new one otherwise. Self-signed, RSA, ten years;
 * the key file is readable by this account alone.
 */
export async function ensureNetworkCertificate(addresses: readonly string[], run: OpensslRunner = runOpenssl): Promise<NetworkCertificate> {
  const files = networkCertificateFiles();
  const names = certificateNames(addresses);
  try {
    const meta = JSON.parse(await readFile(files.meta, "utf8")) as { addresses?: unknown; fingerprint?: unknown };
    if (Array.isArray(meta.addresses) && typeof meta.fingerprint === "string" && JSON.stringify(meta.addresses) === JSON.stringify(names)) {
      const [cert, key] = await Promise.all([readFile(files.cert, "utf8"), readFile(files.key, "utf8")]);
      return { cert, key, fingerprint: meta.fingerprint, addresses: names };
    }
  } catch {
    // Nothing on disk, or not for these addresses: minted below.
  }
  await mkdir(dirname(files.cert), { recursive: true });
  const config = join(dirname(files.cert), "network-cert.cnf");
  await writeFile(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      "CN = Solution Builder on this computer",
      "[ext]",
      `subjectAltName = ${names.map((name) => `IP:${name}`).join(",")}`,
      "basicConstraints = CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "",
    ].join("\n"),
  );
  try {
    await run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", files.key, "-out", files.cert, "-days", String(CERTIFICATE_DAYS), "-config", config]);
  } finally {
    await rm(config, { force: true });
  }
  await chmod(files.key, 0o600);
  const printed = await run(["x509", "-in", files.cert, "-noout", "-fingerprint", "-sha256"]);
  const fingerprint = /=\s*([0-9A-Fa-f:]+)/.exec(printed)?.[1]?.toUpperCase() ?? "";
  if (!fingerprint) throw new HostError("internal_error", "openssl did not print the certificate's fingerprint.");
  await writeFile(files.meta, `${JSON.stringify({ addresses: names, fingerprint, issuedAt: new Date().toISOString() }, null, 2)}\n`);
  const [cert, key] = await Promise.all([readFile(files.cert, "utf8"), readFile(files.key, "utf8")]);
  return { cert, key, fingerprint, addresses: names };
}

/** The listener `serve.ts` keeps for the network: what a settings change acts through. */
export type LanListener = {
  /** Binds `port` serving `certificate`, or a free port when 0 or when that one is taken; answers the port bound. */
  start(port: number, certificate: NetworkCertificate): Promise<number>;
  stop(): Promise<void>;
  /** The port bound now; null while the listener is down. */
  port(): number | null;
  /** The link that signs a device in at `host`:`port`, as the console's launch URL does. */
  launchUrl(host: string, port: number): string;
};

let listener: LanListener | null = null;

export function registerLanListener(control: LanListener | null): void {
  listener = control;
}

export type NetworkAccessStatus = {
  readonly lan: boolean;
  /** The network listener's port while it is up; null when it is not. */
  readonly port: number | null;
  /** This machine's network addresses, each with the link to open there; empty while the listener is down. */
  readonly addresses: readonly { readonly address: string; readonly url: string }[];
  /** The served certificate's SHA-256 fingerprint while the listener is up, for a person to check against the device's warning. */
  readonly fingerprint: string | null;
};

/** The certificate the listener is serving now; null while it is down. */
let serving: NetworkCertificate | null = null;

export async function networkAccessStatus(): Promise<NetworkAccessStatus> {
  const settings = await readNetworkAccess();
  const port = listener?.port() ?? null;
  const addresses = port === null || !listener ? [] : lanAddresses().map((address) => ({ address, url: listener!.launchUrl(address, port) }));
  return { lan: settings.lan, port, addresses, fingerprint: port === null ? null : (serving?.fingerprint ?? null) };
}

/**
 * Brings the listener in step with the setting: up when the setting says
 * so, on the remembered port while it is free, down otherwise. The port
 * actually bound is remembered for next time. A listener up with a
 * certificate for other addresses than this computer has now (it moved
 * network) is brought down and up again on a new one. Run at launch,
 * after every save, and on every read of the status.
 */
export async function applyNetworkAccess(run?: OpensslRunner): Promise<NetworkAccessStatus> {
  const settings = await readNetworkAccess();
  if (!listener) return networkAccessStatus();
  let up = listener.port();
  if (settings.lan && up !== null && serving && JSON.stringify(serving.addresses) !== JSON.stringify(certificateNames(lanAddresses()))) {
    await listener.stop();
    serving = null;
    up = null;
  }
  if (settings.lan && up === null) {
    const certificate = await ensureNetworkCertificate(lanAddresses(), run);
    const bound = await listener.start(settings.lanPort, certificate);
    serving = certificate;
    if (bound !== settings.lanPort) await saveNetworkAccess({ lanPort: bound });
  } else if (!settings.lan && up !== null) {
    await listener.stop();
    serving = null;
  }
  return networkAccessStatus();
}

/**
 * Saves the toggle and applies it at once. A listener that cannot start
 * leaves the setting off, so Settings never shows "On" over nothing, and
 * the failure is the answer.
 */
export async function setNetworkAccess(patch: { readonly lan?: boolean }, run?: OpensslRunner): Promise<NetworkAccessStatus> {
  if (patch.lan !== undefined) await saveNetworkAccess({ lan: patch.lan });
  try {
    return await applyNetworkAccess(run);
  } catch (cause) {
    await saveNetworkAccess({ lan: false });
    throw cause instanceof HostError ? cause : new HostError("internal_error", `The host could not listen on the network: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
