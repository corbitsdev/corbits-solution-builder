/**
 * The embedded host's process skeleton.
 *
 * A Bun process that binds a random loopback port, mints a session token, and
 * prints a launch URL for the native shell to open, under one lifetime rule:
 *
 *   Closing the window does not stop this process. Only an explicit stop does.
 *
 * The shell therefore does not reap the sidecar on window close, and this
 * process does not exit when its parent's window goes away.
 *
 * Everything that makes the running product *itself* arrives through
 * `initHost` (naming, env names, the handshake string the shell greps for)
 * and `serveHost`'s options (the `/api` routes, where the built interface
 * lives). Nothing here is a product API.
 */
import { timingSafeEqual } from "node:crypto";
import { extname, join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { Hono } from "hono";
import { openDatabase } from "./db.js";
import { hostIdentity } from "./identity.js";
import { databaseDirectory, dataDirectory, portFile } from "./paths.js";
import { stopSpawnedSidecars } from "./sidecar-processes.js";
import { ensureHub, hubMode, remoteHubOrigin, resolveWorkspace } from "./hub-client.js";
import { hub, hubWebSocket, setHostPort, SIDECAR_WS_PATH } from "./hub-mount.js";
import { readSecretResult, secretReference, storeSecret } from "./host-secrets.js";
import {
  clientConnected,
  markReady,
  markStopped,
  startHeartbeat,
} from "./lifecycle.js";

export interface ServeOptions {
  /** The product's own routes, mounted under `/api` behind the session door. */
  api: Hono;
  /** Where the built interface may live, in order; the first directory with
   *  an `index.html` wins, the last names the failure. */
  distDirs: string[];
  /** The API version string the startup log line reports. */
  apiVersion: string;
}

function numberFlag(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value)) throw new Error(`${name} requires an integer.`);
  return value;
}

const SESSION_TOKEN_ACCOUNT = "hub:session-token";

const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export async function serveHost(options: ServeOptions): Promise<void> {
  const { displayName, envPrefix, sessionCookie, handshakePrefix, hubConfigScriptId, globalTokenKey, connectSrcExtra, interfaceBuildHint } =
    hostIdentity();

  const requestedPort = numberFlag("--port") ?? 0;
  if (requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("--port must be between 0 and 65535.");
  }
  // Sidecars dial back into the hub on this port, and the hub has to know the
  // number before it mounts, so a free port is claimed here rather than left to
  // `Bun.serve` to pick later. The platform binds each sidecar allocation to
  // the hub's address, port included, and an allocation bound to another
  // address is one it will never touch again; so the port the host served on
  // last time is taken again whenever it is still free, and a fresh one only
  // when it is not.
  await mkdir(dataDirectory(), { recursive: true });
  const port = requestedPort || (await rememberedPort()) || (await freePort());
  setHostPort(port);
  await Bun.write(portFile(), `${port}\n`);

  async function rememberedPort(): Promise<number | null> {
    const remembered = Number((await Bun.file(portFile()).text().catch(() => "")).trim());
    if (!Number.isInteger(remembered) || remembered <= 0 || remembered > 65_535) return null;
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: remembered, fetch: () => new Response() });
      await probe.stop(true);
      return remembered;
    } catch {
      return null;
    }
  }

  async function freePort(): Promise<number> {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const chosen = probe.port!;
    await probe.stop(true);
    return chosen;
  }

  await mkdir(dataDirectory(), { recursive: true });
  await mkdir(databaseDirectory(), { recursive: true });

  const host = await openDatabase(databaseDirectory());

  // A hosted hub owns its own schema and its own database. Applying
  // Interchange's migrations locally in that mode would create a second,
  // divergent control plane — the exact thing the hub exists to prevent.
  if (hubMode() === "embedded") {
    const { migrateHub } = await import("./hub-migrate.js");
    const migrated = await migrateHub(host);
    if (migrated.applied.length > 0) {
      console.log(`Applied Interchange migrations: ${migrated.applied.join(", ")}`);
    }
  }

  const hubEndpoint = await ensureHub();
  console.log(`Interchange hub: ${hubEndpoint.detail}`);

  // If a previous session's workspace is already resolvable (scripts that
  // signed in before serving), name it; otherwise the client installs one.
  const known = await resolveWorkspace().catch((cause: unknown) => {
    console.error("Could not resolve the workspace:", cause);
    return null;
  });
  console.log(known ? `Workspace: tenant ${known.tenantId}` : "Workspace: not installed yet");

  /**
   * Minting a fresh token on every launch invalidated every cookie a browser
   * already held the moment the host restarted — the workspace and its data
   * survive a restart, but the token proving a session's cookie was legitimate
   * did not, so every request the client made looked unauthorised until it
   * redid the handshake. Persisted the same way the repo-signing seed is
   * (`hub-keys.ts`), so a restart against the same data reuses the same token
   * and an already-open browser stays authorised.
   */
  async function resolveSessionToken(): Promise<string> {
    const stored = await readSecretResult(await secretReference(SESSION_TOKEN_ACCOUNT));
    if (stored.status === "found" && stored.secret) return stored.secret;

    // A store that cannot answer is not an empty store. Minting here would
    // invalidate every cookie a running client already holds for no reason —
    // the same caution `hub-keys.ts` takes with the signing seed.
    if (stored.status === "unavailable") {
      throw new Error(
        `The keychain could not be read for ${SESSION_TOKEN_ACCOUNT}: ${stored.detail}. ` +
          "Nothing has been changed. Unlock the keychain, or allow this app access, " +
          "and start it again.",
      );
    }

    const minted = crypto.randomUUID();
    await storeSecret(SESSION_TOKEN_ACCOUNT, minted);
    return minted;
  }

  /**
   * Held on `globalThis` too, so `bun --hot` keeps the same token in memory
   * across a reload without a round trip to the keychain on every edit.
   */
  const session = globalThis as typeof globalThis & Record<string, string | undefined>;
  const token = (session[globalTokenKey] ??= await resolveSessionToken());

  /**
   * Where the built interface lives: whatever the caller ordered — the
   * shell's resource dir first, then its fallbacks. The compiled binary's
   * `import.meta.dir` is inside its virtual filesystem, so only a checkout
   * path would leave a bare binary serving nothing.
   */
  async function resolveDist(): Promise<string> {
    for (const candidate of options.distDirs) {
      if (await Bun.file(join(candidate, "index.html")).exists()) return candidate;
    }
    return options.distDirs.at(-1)!;
  }

  const dist = await resolveDist();

  /**
   * Tells the served interface where the hub lives. Embedded, this is absent —
   * the hub is mounted on this same origin, so the transport uses relative
   * paths. Remote, it is `<envPrefix>_HUB_URL`: the interface reads it and
   * calls that origin directly, with `credentials: "include"`, rather than
   * through this host.
   *
   * A `<script type="application/json">` block, not an executable inline
   * script: the CSP below only allows `script-src 'self'`, and a JSON block is
   * inert data the page reads, not a script the CSP would need to permit.
   */
  function injectHubOrigin(html: string): string {
    const config = { hubUrl: remoteHubOrigin() };
    const json = JSON.stringify(config).replace(/<\//g, "<\\/");
    const block = `<script type="application/json" id="${hubConfigScriptId}">${json}</script>`;
    return html.includes("</head>") ? html.replace("</head>", `${block}</head>`) : `${block}${html}`;
  }

  /**
   * The webview loads this server directly, so the shell's own CSP never
   * applies and the policy has to arrive as a response header from here.
   * Everything is same-origin; `style-src` allows inline because React writes
   * style attributes. `connectSrcExtra` carries the product's own needs —
   * shell IPC schemes, provider endpoints the page calls itself.
   */
  /** Set by the development launcher; absent in a packaged app. */
  const devReload = process.env[`${envPrefix}_DEV_RELOAD`] === "1";

  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${connectSrcExtra.join(" ")}`.trim(),
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const app = new Hono();

  /**
   * Authorises a client. A loopback port is not authentication: anything else
   * on the machine can reach it.
   *
   * Two credentials are accepted. The window presents the session cookie it
   * was handed at the handshake. Another process — a hub client, a future
   * CLI — presents the same token as a bearer, which is what lets this host
   * be the hub endpoint for a separate instance of the product.
   */
  function authorised(context: { req: { header: (name: string) => string | undefined } }) {
    const cookie = context.req.header("cookie") ?? "";
    const presented = cookie
      .split(/;\s*/)
      .find((entry) => entry.startsWith(`${sessionCookie}=`))
      ?.slice(sessionCookie.length + 1);
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

  // The outer door. Without this the host would be an open proxy into the hub
  // for anything on the machine, which is the loopback assumption the rest of
  // the host explicitly rejects. Everything past it — the host's own routes
  // and, embedded, the hub's own mounted routes — sees the client's own
  // cookies untouched. There is no owner-cookie swap here.
  //
  // The hub's own bare `/status` is deliberately outside this door: it is
  // public on the hub's own side too (`vendor/interchange/packages/hub-api/src
  // /app.ts`'s auth `skip`), so mounting it behind a token here would make
  // this host less permissive than the hub it embeds, for a route that
  // answers nothing but `{ status: "ok" }`.
  app.use("/api/*", async (context, next) => {
    if (!authorised(context)) return context.json(unauthorised, 401);
    await next();
  });

  app.route("/api", options.api);

  // The client connects to the hub directly: embedded, its own Hono app is
  // mounted here unmodified, at its own paths (`/api/tenants/...`, `/api/me`,
  // `/api/auth/...`, the bare `/status` health route) — no prefix, no fetch
  // relay, no rewritten cookies. The product's routes above already claimed
  // every path the host itself owns, so this only ever answers what they did
  // not.
  //
  // Remote (`<envPrefix>_HUB_URL` set): there is no local hub to mount. The
  // browser is handed that origin directly (see the `index.html` injection
  // below) and talks to it itself; this host forwards nothing on its behalf.
  if (hubMode() === "embedded") {
    app.route("/", hub().app);
  }

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

      // The handshake URL exchanges the token for an HttpOnly cookie once.
      // Every other query parameter survives the redirect, so a deep link such
      // as `?view=settings` still lands where it was aimed.
      if (url.pathname === "/" && url.searchParams.get("token") === token) {
        clientConnected();
        const onward = new URLSearchParams(url.searchParams);
        onward.delete("token");
        const query = onward.toString();
        return new Response(null, {
          status: 302,
          headers: {
            location: query ? `/?${query}` : "/",
            "set-cookie": `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          },
        });
      }

      // Development only: a stream that says when the interface has been
      // rebuilt. The launcher rebuilds on every edit but the window had no
      // way to know, so the loop was "edit, alt-tab, reload by hand". Never
      // mounted unless the launcher asks for it, so a packaged app has no
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

      // The host's own routes and the hub's own routes (`/api/tenants/...`,
      // `/api/me`, `/api/auth/...`, and the hub's bare `/status`) both go to
      // Hono, at their own paths with no prefix; everything else is the built
      // interface.
      if (url.pathname.startsWith("/api/") || url.pathname === "/status") {
        return app.fetch(request);
      }

      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const candidate = join(dist, requested);
      const info = await stat(candidate).catch(() => null);
      const selected = info?.isFile() ? candidate : join(dist, "index.html");
      const file = Bun.file(selected);
      if (!(await file.exists())) {
        return new Response(
          `The ${displayName} interface has not been built. Run \`${interfaceBuildHint}\`.`,
          { status: 503, headers: { "content-type": "text/plain" } },
        );
      }
      // The SPA fallback always serves index.html, so this covers every
      // client-side route too, not just `/`.
      if (extname(selected) === ".html") {
        const html = await file.text();
        return new Response(injectHubOrigin(html), {
          headers: {
            "content-type": "text/html",
            "cache-control": "no-store",
            "content-security-policy": CSP,
          },
        });
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

  // Development only: the native shell passes its own pid, and the host ends
  // when that process is gone. A rebuild kills the window outright, without a
  // chance to stop the host, and an orphaned host would hold the workspace
  // against the next one. A packaged app passes nothing here.
  const parentPid = numberFlag("--parent-pid");
  if (parentPid !== undefined && parentPid > 0) {
    const watch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(watch);
        void stop().finally(() => process.exit(0));
      }
    }, 1000);
  }

  // SIGTERM is an explicit stop. There is deliberately no parent-process
  // monitor: the window going away must not end the host.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stop().finally(() => process.exit(0));
    });
  }

  const launchURL = `http://127.0.0.1:${server.port}/?token=${token}`;
  console.log(`${displayName} host: http://127.0.0.1:${server.port} (api v${options.apiVersion})`);
  console.log(`${handshakePrefix}${launchURL}`);
  if (process.argv.includes("--open")) Bun.spawn(["open", launchURL]);
}
