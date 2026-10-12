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
 */
import { networkInterfaces } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** The listener `serve.ts` keeps for the network: what a settings change acts through. */
export type LanListener = {
  /** Binds `port`, or a free one when 0 or when that one is taken; answers the port bound. */
  start(port: number): Promise<number>;
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
};

export async function networkAccessStatus(): Promise<NetworkAccessStatus> {
  const settings = await readNetworkAccess();
  const port = listener?.port() ?? null;
  const addresses = port === null || !listener ? [] : lanAddresses().map((address) => ({ address, url: listener!.launchUrl(address, port) }));
  return { lan: settings.lan, port, addresses };
}

/**
 * Brings the listener in step with the setting: up when the setting says
 * so, on the remembered port while it is free, down otherwise. The port
 * actually bound is remembered for next time. Run at launch, and after
 * every save.
 */
export async function applyNetworkAccess(): Promise<NetworkAccessStatus> {
  const settings = await readNetworkAccess();
  if (!listener) return networkAccessStatus();
  const up = listener.port();
  if (settings.lan && up === null) {
    const bound = await listener.start(settings.lanPort);
    if (bound !== settings.lanPort) await saveNetworkAccess({ lanPort: bound });
  } else if (!settings.lan && up !== null) {
    await listener.stop();
  }
  return networkAccessStatus();
}

/**
 * Saves the toggle and applies it at once. A listener that cannot start
 * leaves the setting off, so Settings never shows "On" over nothing, and
 * the failure is the answer.
 */
export async function setNetworkAccess(patch: { readonly lan?: boolean }): Promise<NetworkAccessStatus> {
  if (patch.lan !== undefined) await saveNetworkAccess({ lan: patch.lan });
  try {
    return await applyNetworkAccess();
  } catch (cause) {
    await saveNetworkAccess({ lan: false });
    throw cause instanceof HostError ? cause : new HostError("internal_error", `The host could not listen on the network: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
