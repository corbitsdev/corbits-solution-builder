/**
 * The Solutions Builder host.
 *
 * A Bun process that binds a random loopback port, mints a session token, and
 * prints a launch URL for the Tauri host to open. The pattern is the proven one
 * from the AgentFlight Alpha spike; what differs is the lifetime rule:
 *
 *   Closing the window does not stop this process. Only an explicit stop does.
 *
 * The desktop host therefore does not reap the sidecar on window close, and
 * this process does not exit when its parent's window goes away.
 */
import { timingSafeEqual } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { Hono } from "hono";
import { API_VERSION, createApi } from "./api.js";
import { openDatabase } from "./db.js";
import { prepareDatabase } from "./migrate.js";
import { databaseDirectory, dataDirectory } from "./paths.js";
import { stopSpawnedSidecars } from "./sidecar-processes.js";
import { ensureHub, hubFetch, resolveWorkspace } from "./hub-client.js";
import { hub, hubWebSocket, setHostPort, SIDECAR_WS_PATH } from "./hub-mount.js";
import {
  clientConnected,
  markReady,
  markStopped,
  onHostStop,
  startHeartbeat,
} from "./lifecycle.js";

const HANDSHAKE_PREFIX = "Solutions Builder launch URL: ";

function numberFlag(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value)) throw new Error(`${name} requires an integer.`);
  return value;
}

const requestedPort = numberFlag("--port") ?? 0;
if (requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("--port must be between 0 and 65535.");
}
// Sidecars dial back into the hub on this port, and the hub has to know the
// number before it mounts, so a free port is claimed here rather than left to
// `Bun.serve` to pick later.
const port = requestedPort || (await freePort());
setHostPort(port);

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const chosen = probe.port!;
  await probe.stop(true);
  return chosen;
}

await mkdir(dataDirectory(), { recursive: true });
await mkdir(databaseDirectory(), { recursive: true });

const host = await openDatabase(databaseDirectory());

// Interchange owns the control plane and its schema is applied first, because
// Builder's foreign keys point into it. `prepareDatabase` owns that order.
const migrated = await prepareDatabase(host);
if (migrated.interchange > 0) {
  console.log(`Applied ${migrated.interchange} Interchange migrations`);
}
if (migrated.builder.length > 0) {
  console.log(`Applied Builder migrations: ${migrated.builder.join(", ")}`);
}

const hubEndpoint = await ensureHub();
console.log(`Interchange hub: ${hubEndpoint.detail}`);

// Not seeding: signing in. If the owner and their workspace already exist, the
// host knows which tenant it serves; if not, the client installs one.
const known = await resolveWorkspace().catch((cause: unknown) => {
  console.error("Could not resolve the workspace:", cause);
  return null;
});
console.log(known ? `Workspace: tenant ${known.tenantId}` : "Workspace: not installed yet");

// Boot ends here. Everything that makes this tenant Solutions Builder — the
// owner principal, workflow definitions, roles, specialist prompts — is
// installed on the client's request through `POST /api/install`.

/**
 * Held on `globalThis` so `bun --hot` keeps the same token across a reload;
 * re-minting it would invalidate the cookie the loaded webview already holds.
 * A packaged launch is a fresh process, so this is identical to per-run.
 */
const session = globalThis as typeof globalThis & { solutionsBuilderToken?: string };
const token = (session.solutionsBuilderToken ??= crypto.randomUUID());

/**
 * Where the built interface lives, in the order the host should look:
 *   1. what the desktop host passes (Tauri bundles `dist/` as a resource);
 *   2. a `dist/` beside the executable, for a standalone binary;
 *   3. the web app's own `dist/`, for `bun run dev`.
 * The compiled binary's `import.meta.dir` is inside its virtual filesystem, so
 * step 3 alone would leave a bare binary serving nothing.
 */
async function resolveDist(): Promise<string> {
  const candidates = [
    process.env.SOLUTIONS_BUILDER_DIST_DIR?.trim(),
    join(dirname(process.execPath), "dist"),
    join(import.meta.dir, "..", "..", "web", "dist"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await Bun.file(join(candidate, "index.html")).exists()) return candidate;
  }
  return candidates.at(-1)!;
}

const dist = await resolveDist();

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * The webview loads this server directly, so Tauri's own CSP never applies and
 * the policy has to arrive as a response header from here. Everything is
 * same-origin; `style-src` allows inline because React writes style attributes.
 */
/** Set by `bun run dev`; absent in a packaged app. */
const devReload = process.env.SOLUTIONS_BUILDER_DEV_RELOAD === "1";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const app = new Hono();

/**
 * Authorises a client. A loopback port is not authentication: anything else on
 * the machine can reach it.
 *
 * Two credentials are accepted. The window presents the session cookie it was
 * handed at the handshake. Another process — a hub client, a future CLI —
 * presents the same token as a bearer, which is what lets this host be the hub
 * endpoint for a separate Solutions Builder instance.
 */
function authorised(context: { req: { header: (name: string) => string | undefined } }) {
  const cookie = context.req.header("cookie") ?? "";
  const presented = cookie
    .split(/;\s*/)
    .find((entry) => entry.startsWith("solutions_builder_session="))
    ?.slice("solutions_builder_session=".length);
  if (presented !== undefined && sameToken(presented, token)) return true;
  const authorization = context.req.header("authorization") ?? "";
  return authorization.startsWith("Bearer ") && sameToken(authorization.slice(7), token);
}

/** Compared in constant time: the token is the only thing guarding the API. */
function sameToken(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const unauthorised = {
  error: {
    code: "unauthenticated",
    message: "This client is not authorised.",
    correlationId: "-",
    retryable: false,
  },
};

app.use("/api/*", async (context, next) => {
  if (!authorised(context)) return context.json(unauthorised, 401);
  await next();
});

// The hub proxy is guarded too. Without this the host would be an open proxy
// into the hub for anything on the machine, which is the loopback assumption
// the rest of the host explicitly rejects. The hub's own auth still applies
// underneath; this is the outer door, not a replacement for it.
app.use("/hub/*", async (context, next) => {
  if (!authorised(context)) return context.json(unauthorised, 401);
  await next();
});

app.route("/api", createApi());

// The hub's own API, proxied under /hub so a client reaches it through the same
// authenticated origin. Embedded, this dispatches in-process; pointed at a
// hosted hub it forwards. Clients cannot tell the difference, which is the
// point of the seam.
app.all("/hub/*", async (context) => {
  const url = new URL(context.req.url);
  const path = url.pathname.replace(/^\/hub/, "") + url.search;
  return hubFetch(path, {
    method: context.req.method,
    headers: context.req.raw.headers,
    ...(context.req.method === "GET" || context.req.method === "HEAD"
      ? {}
      : { body: await context.req.raw.arrayBuffer() }),
  });
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 240,
  websocket: hubWebSocket,
  async fetch(request, server) {
    const url = new URL(request.url);

    // A sidecar's socket into the hub. It carries the sidecar's own bearer
    // token, which the hub checks; the host's session token does not apply.
    if (url.pathname === SIDECAR_WS_PATH) return hub().app.fetch(request, server);

    // The handshake URL exchanges the token for an HttpOnly cookie once. Every
    // other query parameter survives the redirect, so a deep link such as
    // `?view=settings` still lands where it was aimed.
    if (url.pathname === "/" && url.searchParams.get("token") === token) {
      clientConnected();
      const onward = new URLSearchParams(url.searchParams);
      onward.delete("token");
      const query = onward.toString();
      return new Response(null, {
        status: 302,
        headers: {
          location: query ? `/?${query}` : "/",
          "set-cookie": `solutions_builder_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        },
      });
    }

    // Development only: a stream that says when the interface has been
    // rebuilt. `bun run dev` rebuilds on every edit but the window
    // had no way to know, so the loop was "edit, alt-tab, reload by hand".
    // Never mounted unless the launcher asks for it, so a packaged app has no
    // such route at all.
    if (devReload && url.pathname === "/api/dev/reload") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(": connected\n\n"));
          let timer: ReturnType<typeof setTimeout> | null = null;
          const watcher = watch(dist, { recursive: true }, () => {
            // The build writes many files; one reload for the burst.
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              controller.enqueue(encoder.encode("event: rebuilt\ndata: 1\n\n"));
            }, 120);
          });
          request.signal.addEventListener("abort", () => {
            if (timer) clearTimeout(timer);
            watcher.close();
            controller.close();
          });
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    }

    // Both the Builder API and the proxied hub go to Hono; everything else is
    // the built interface.
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/hub/")) {
      return app.fetch(request);
    }

    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const candidate = join(dist, requested);
    const info = await stat(candidate).catch(() => null);
    const selected = info?.isFile() ? candidate : join(dist, "index.html");
    const file = Bun.file(selected);
    if (!(await file.exists())) {
      return new Response(
        "The Solutions Builder interface has not been built. Run `bun run ui:build`.",
        { status: 503, headers: { "content-type": "text/plain" } },
      );
    }
    return new Response(file, {
      headers: {
        "content-type": mime[extname(selected)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "content-security-policy": CSP,
      },
    });
  },
});

startHeartbeat();
markReady();

let stopping: Promise<void> | undefined;
async function stop(): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    await server.stop(true);
    await stopSpawnedSidecars(join(dataDirectory(), "hub")).catch(() => 0);
    await host.close();
    markStopped();
  })();
  return stopping;
}

onHostStop(() => {
  void stop().finally(() => process.exit(0));
});

// SIGTERM is an explicit stop. There is deliberately no parent-process monitor:
// the window going away must not end the host.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}

const launchURL = `http://127.0.0.1:${server.port}/?token=${token}`;
console.log(`Solutions Builder host: http://127.0.0.1:${server.port} (api v${API_VERSION})`);
console.log(`${HANDSHAKE_PREFIX}${launchURL}`);
if (process.argv.includes("--open")) Bun.spawn(["open", launchURL]);
