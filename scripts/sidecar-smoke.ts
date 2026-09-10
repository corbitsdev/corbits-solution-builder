/**
 * Proves the executor process is real: the embedded hub is wired for sidecar
 * allocation, and Interchange's own sidecar, spawned the way the process
 * provisioner spawns it, connects to this host's hub and registers.
 *
 * What is not proven yet: an allocation created by a workflow deployment.
 * That needs a workflow-kind asset holding workflow source, which the
 * generated definitions are not (Sidecar 2). The probe identity here is the
 * fixture the deploy path would have written before spawning.
 *
 * Usage: bun --conditions intx-src scripts/sidecar-smoke.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

const dataDir = await mkdtemp(join(tmpdir(), "sb-sidecar-"));
process.env["SOLUTIONS_BUILDER_DATA_DIR"] = dataDir;

const { openDatabase } = await import("../apps/hub/src/db.js");
const { prepareDatabase } = await import("../apps/hub/src/migrate.js");
const { hub, hubWebSocket, mountHub, setHostPort, SIDECAR_WS_PATH } = await import(
  "../apps/hub/src/hub-mount.js"
);

const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!;
await probe.stop(true);
setHostPort(port);

const host = await openDatabase(join(dataDir, "pglite"));
await prepareDatabase(host);
await mountHub();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  websocket: hubWebSocket,
  fetch: (request, bun) => hub().app.fetch(request, bun),
});

let child: Bun.Subprocess | undefined;
try {
  // The deploy route knows provisioning is configured: an unauthenticated
  // call is refused for auth, never with "provisioning unavailable".
  const deploy = await hub().app.request("/api/tenants/t/workflows/deployments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("the deploy route is mounted with provisioning behind it", deploy.status === 401, String(deploy.status));

  // The fixture the allocation service writes before it spawns a probe.
  const token = `intx_sc_${crypto.randomUUID().replace(/-/g, "")}`;
  // The hub matches the token's SHA-256 digest, the same hash `@intx/crypto` computes.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const run = async (statement: ReturnType<typeof sql>) => host.db.execute(statement);
  await run(sql`INSERT INTO "public"."tenant" ("id","name","slug","domain") VALUES ('t_smoke','Smoke','smoke','smoke.localhost')`);
  await run(sql`INSERT INTO "public"."asset" ("id","tenant_id","kind","name") VALUES ('ast_smoke','t_smoke','workflow','smoke')`);
  await run(sql`INSERT INTO "public"."sidecar" ("id","token_hash_sha256","status") VALUES ('sc_smoke', decode(${hex}, 'hex'), 'offline')`);
  await run(sql`INSERT INTO "public"."workflow_probe"
    ("id","tenant_id","definition_asset_id","source","entry","status","provisioner_id","provisioner_api_version","provisioner_binding_fingerprint","sidecar_id","generation")
    VALUES ('prb_smoke','t_smoke','ast_smoke','{"kind":"asset","assetId":"ast_smoke"}'::jsonb,'index.ts','provisioning','process',1,'smoke','sc_smoke',1)`);

  hub().sidecars.fence("prb_smoke", 1);

  const root = join(import.meta.dir, "..");
  const entry = join(root, "vendor", "interchange", "apps", "sidecar", "src", "index.ts");
  const sidecarDir = join(dataDir, "sidecar");
  child = Bun.spawn([join(root, "apps", "hub", "bin", "sidecar-runtime"), entry], {
    cwd: join(entry, ".."),
    env: {
      PATH: process.env["PATH"]!,
      HOME: process.env["HOME"]!,
      SIDECAR_DATA_DIR: sidecarDir,
      HUB_WS_URL: `ws://127.0.0.1:${port}${SIDECAR_WS_PATH}`,
      SIDECAR_ID: "sc_smoke",
      SIDECAR_TOKEN: token,
      SIDECAR_CREDENTIAL_ENCRYPTION_KEY: process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"]!,
    },
    stdout: process.env["SIDECAR_SMOKE_DEBUG"] ? "inherit" : "pipe",
    stderr: process.env["SIDECAR_SMOKE_DEBUG"] ? "inherit" : "pipe",
  });

  const deadline = Date.now() + Number(process.env["SIDECAR_SMOKE_TIMEOUT_MS"] ?? 90_000);
  while (Date.now() < deadline && !hub().sidecars.connected().includes("sc_smoke")) {
    if (child.exitCode !== null) break;
    await Bun.sleep(250);
  }
  const connected = hub().sidecars.connected();
  const stderr = child.exitCode !== null ? await new Response(child.stderr as ReadableStream).text() : "";
  check(
    "Interchange's sidecar starts under the provisioner's runtime and registers with this hub",
    connected.includes("sc_smoke"),
    connected.length ? connected.join(",") : stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300),
  );
} finally {
  child?.kill();
  await server.stop(true);
  await host.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`Sidecar smoke: ${passed}/${checks.length} checks passed`);
if (passed !== checks.length) process.exit(1);
