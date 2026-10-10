/**
 * A script's way into a Solution Builder host as the workspace owner.
 *
 * The host's outer door takes its launch token as a bearer, and the owner's
 * own hub session is what `POST /api/owner/session` sets on an embedded hub
 * (`packages/embedded-host/src/serve.ts`, `apps/hub/src/api-host.ts`). A
 * script holds both the way a browser tab would: the token on every request,
 * the hub's cookies in a jar it fills from each response.
 *
 * `startHost` runs the app's own entry on a data directory and reads the
 * launch line for the port and token, for a script that must drive a host no
 * window has open. `attachHost` reaches one already running: the port it
 * remembered in `<data>/port` and the token it keeps in the keychain.
 */
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, type Transport } from "@intx/hub-client";
import { portFile } from "@corbits/embedded-host";
import { readSecretResult, secretReference } from "@corbits/keychain";
import { pushSourceTree, type ClosureSource, type WorkflowGitPush } from "@solutions-builder/installer";
import { IDENTITY } from "../../apps/hub/src/identity.js";
import { buildManifest, buildPackedEntries } from "../closure-pack.ts";

const root = join(import.meta.dir, "..", "..");

/** The keychain account the host keeps its session token under (`serve.ts`). */
const SESSION_TOKEN_ACCOUNT = "hub:session-token";

export type Host = {
  readonly origin: string;
  readonly token: string;
  /** Ends the host when this script started it; nothing when it attached to one. */
  readonly stop: () => Promise<void>;
};

/** The port and token of a launch line, or null when `text` has none yet. */
export function parseLaunchLine(text: string): { origin: string; token: string } | null {
  const match = /launch URL: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9-]+)/.exec(text);
  return match ? { origin: `http://127.0.0.1:${match[1]!}`, token: match[2]! } : null;
}

export async function startHost(dataDir: string): Promise<Host> {
  const child = Bun.spawn(["bun", join(root, "apps", "hub", "src", "server.ts"), "--port", "0"], {
    cwd: root,
    env: { ...process.env, SOLUTIONS_BUILDER_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = async () => {
    child.kill("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000))]);
    if (!exited) child.kill("SIGKILL");
  };
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const launched = parseLaunchLine(buffer);
    if (launched) {
      // Keep draining so the child never blocks on a full pipe; nothing it
      // prints after the handshake is this script's to echo.
      void (async () => {
        while (!(await reader.read()).done) {
          // drained
        }
      })().catch(() => undefined);
      return { ...launched, stop };
    }
  }
  reader.releaseLock();
  const stderr = await new Response(child.stderr).text().catch(() => "");
  child.kill();
  throw new Error(`the host never reached its handshake: ${(stderr || buffer).slice(-600)}`);
}

/** The token a host on this machine presents, as the host itself resolves it. */
export async function storedSessionToken(): Promise<string | null> {
  const stored = await readSecretResult(await secretReference(SESSION_TOKEN_ACCOUNT));
  return stored.status === "found" && stored.secret ? stored.secret : null;
}

/** Whether a host answers at `origin` for `token`. */
export async function hostAnswers(origin: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The host already running on this machine's data directory, found by the
 * port it remembered and the token it keeps. Null when nothing answers there,
 * which is also what a host on a new port, or a stale port file, looks like.
 */
export async function attachHost(): Promise<Host | null> {
  const port = Number((await Bun.file(portFile()).text().catch(() => "")).trim());
  if (!Number.isInteger(port) || port <= 0) return null;
  const token = await storedSessionToken();
  if (!token) return null;
  const origin = `http://127.0.0.1:${String(port)}`;
  if (!(await hostAnswers(origin, token))) return null;
  return { origin, token, stop: async () => undefined };
}

export type OwnerSession = {
  readonly transport: Transport;
  /** The jar as a `Cookie` header value: the host's session plus whatever the hub set. */
  readonly cookie: () => string;
  /** A raw request through the door, for a route that answers bytes rather than JSON. */
  readonly fetchRaw: (path: string, init?: RequestInit) => Promise<Response>;
};

/**
 * A transport into the running host as the workspace owner: the host's
 * outer door takes the launch token as a bearer, and the owner's own hub
 * session is what `POST /api/owner/session` sets, captured into the
 * jar the way a browser tab would keep it.
 */
export function ownerTransport(host: Pick<Host, "origin" | "token">): OwnerSession {
  // The host's own session cookie is the launch token, verbatim: what a
  // browser tab gets from the handshake URL and then carries. The git push
  // carries the minted git token in its Authorization header, so that
  // cookie is the only way it can satisfy the host's outer door.
  const jar = new Map<string, string>([[IDENTITY.sessionCookie, host.token]]);
  const cookie = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const capture = (response: Response) => {
    for (const raw of (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) {
      const pair = raw.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const fetchRaw = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${host.token}`, origin: host.origin };
    if (jar.size > 0) headers.cookie = cookie();
    const response = await fetch(`${host.origin}${path}`, { ...init, headers });
    capture(response);
    return response;
  };
  const transport: Transport = {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const response = await fetchRaw(path, init);
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        // The hub client's own error, as the browser transport throws it: the
        // installer tells a 404 from a failure by `ApiError.status`.
        const detail = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new ApiError(response.status, detail?.code ?? "unknown", `${method} ${path} -> HTTP ${String(response.status)}: ${detail?.message ?? text.slice(0, 300)}`);
      }
      return parsed as T;
    },
    subscribe(): () => void {
      throw new Error("subscribe() is not used here");
    },
  };
  return { transport, cookie, fetchRaw };
}

/**
 * The workflow closure a project workflow deploys with, packed from this
 * checkout the way the interface build does, and a git push of the
 * workflow's source tree through the host's door.
 */
export async function closureAndPush(host: Pick<Host, "origin">, cookie: () => string, generatedBy: string): Promise<{ closure: ClosureSource; gitPush: WorkflowGitPush }> {
  const entries = await buildPackedEntries();
  const manifest = buildManifest(generatedBy, entries);
  const byFilename = new Map(entries.map((entry) => [entry.filename, entry.bytes]));
  const closure: ClosureSource = {
    manifest,
    fetchTarball: async (filename) => {
      const bytes = byFilename.get(filename);
      if (bytes === undefined) throw new Error(`no packed entry for ${filename}`);
      return bytes;
    },
  };
  const gitPush: WorkflowGitPush = async ({ scope, assetKind, assetName, token, tree, message }) => {
    const dir = await mkdtemp(join(tmpdir(), "sb-push-"));
    try {
      const url = `${host.origin}/api/tenants/${encodeURIComponent(scope)}/assets/${assetKind}/${assetName}.git`;
      return await pushSourceTree({
        url,
        token,
        tree,
        message,
        fsBackend: { fs, dir },
        fetchImpl: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie: cookie() } }),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return { closure, gitPush };
}
