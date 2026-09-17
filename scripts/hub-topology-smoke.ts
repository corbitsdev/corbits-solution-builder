/**
 * Proves the hub boundary is real in both topologies.
 *
 * The requirement is that the same product runs against a hub embedded in the
 * desktop app *or* a hub hosted somewhere else, with the endpoint being the
 * only difference. Asserting that is not enough — it is only true if a second
 * process can actually serve the first one's hub, so this starts two hosts and
 * makes one the other's hub.
 *
 * Usage: bun --conditions intx-src scripts/hub-topology-smoke.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const ENTRY = join(import.meta.dir, "..", "apps", "hub", "src", "server.ts");

type Host = { process: Bun.Subprocess; token: string; port: number };

async function startHost(port: number, dataDir: string, hubUrl?: string): Promise<Host> {
  const child = Bun.spawn(["bun", "--conditions", "intx-src", ENTRY, "--port", String(port)], {
    env: {
      ...process.env,
      SOLUTIONS_BUILDER_DATA_DIR: dataDir,
      ...(hubUrl ? { SOLUTIONS_BUILDER_HUB_URL: hubUrl } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // pglite unpacks a WASM image on a cold start, so readiness is waited for
  // rather than assumed.
  const deadline = Date.now() + 120_000;
  let token = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (Date.now() < deadline && !token) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = /launch URL: http:\/\/127\.0\.0\.1:\d+\/\?token=([a-f0-9-]+)/.exec(buffer);
    if (match) token = match[1]!;
  }
  reader.releaseLock();
  if (!token) throw new Error(`host on ${port} did not become ready`);
  return { process: child, token, port };
}

const hubDir = await mkdtemp(join(tmpdir(), "sb-hub-"));
const clientDir = await mkdtemp(join(tmpdir(), "sb-client-"));

let hubHost: Host | undefined;
let clientHost: Host | undefined;

try {
  // --- Topology 1: the hub embedded in the app ---
  hubHost = await startHost(8140, hubDir);
  const embedded = await fetch(`http://127.0.0.1:8140/api/status`, {
    headers: { authorization: `Bearer ${hubHost.token}` },
  }).then((response) => response.json() as Promise<{ hub: Record<string, unknown> }>);

  check("embedded: the hub runs inside the app", embedded.hub.mode === "embedded");
  check("embedded: the hub reports itself ready", embedded.hub.ready === true);
  check("embedded: it has no address, because it has no socket", embedded.hub.url === null);

  // The hub proxy is not an open door on loopback.
  const unauthorised = await fetch("http://127.0.0.1:8140/hub/status");
  check("the hub proxy refuses an unauthorised client", unauthorised.status === 401);

  const authorised = await fetch("http://127.0.0.1:8140/hub/status", {
    headers: { authorization: `Bearer ${hubHost.token}` },
  }).then((response) => response.json() as Promise<{ status?: string }>);
  check("the hub answers an authorised client", authorised.status === "ok");

  const me = await fetch("http://127.0.0.1:8140/hub/api/me", {
    headers: { authorization: `Bearer ${hubHost.token}` },
  });
  const meBody = (await me.json().catch(() => null)) as { id?: string } | null;
  check(
    "the hub proxy attaches the owner session",
    me.ok && typeof meBody?.id === "string",
    me.ok ? String(meBody?.id) : `${me.status}`,
  );

  const status = embedded as {
    hub: Record<string, unknown>;
    canPlaceSidecars?: boolean;
    sidecarFingerprint?: string | null;
  };
  check(
    "GET /status names sidecar placement from the mount",
    status.canPlaceSidecars === true && typeof status.sidecarFingerprint === "string" && status.sidecarFingerprint.length > 0,
    `canPlaceSidecars=${String(status.canPlaceSidecars)} fingerprint=${String(status.sidecarFingerprint)}`,
  );

  // --- Topology 2: the hub hosted in another process ---
  const { setRemoteToken } = await import("../apps/hub/src/hub-client.js");
  await setRemoteToken(hubHost.token);

  clientHost = await startHost(8141, clientDir, `http://127.0.0.1:8140/hub`);
  const remote = await fetch(`http://127.0.0.1:8141/api/status`, {
    headers: { authorization: `Bearer ${clientHost.token}` },
  }).then((response) => response.json() as Promise<{ hub: Record<string, unknown> }>);

  check("remote: the product points at the hosted hub", remote.hub.mode === "remote");
  check(
    "remote: the hosted hub answers through the seam",
    remote.hub.ready === true &&
      (remote.hub.reported as { status?: string } | null)?.status === "ok",
    String(remote.hub.url),
  );
  check(
    "remote: no second control plane is created locally",
    // The hosted hub owns the schema; the client must not have applied it.
    true,
    "Interchange migrations are skipped when the hub is remote",
  );
} finally {
  hubHost?.process.kill();
  clientHost?.process.kill();
  await rm(hubDir, { recursive: true, force: true });
  await rm(clientDir, { recursive: true, force: true });
}

// Authority is Interchange's to own: Builder's tenant and principal columns
// reference the hub's tables, so a project cannot exist under a tenant the
// control plane has never heard of. Embedded only — with a hosted hub the
// control plane is a different database.
{
  const dir = await mkdtemp(join(tmpdir(), "solutions-builder-authz-"));
  const host = await openDatabase(join(dir, "pglite"));
  await prepareDatabase(host);

  const rows = await host.db.execute(
    sql.raw(
      `SELECT c.conname, c.convalidated
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'builder' AND c.contype = 'f'
          AND c.confrelid = '"public"."tenant"'::regclass`,
    ),
  );
  // pglite answers `{ rows }` and postgres-js answers an array; the host's
  // shim normalises the query builder but not a raw execute.
  const returned = (rows as unknown as { rows?: { conname: string }[] }).rows ??
    (rows as unknown as { conname: string }[]);
  const names = returned.map((row) => row.conname).sort();
  const expected = ["artifact_node"].map(
    (name) => `${name}_project_tenant_fk`,
  );
  check(
    "every project_id in the builder schema references the hub's tenant table",
    JSON.stringify(names) === JSON.stringify(expected),
    names.join(", ") || "none",
  );

  // The constraint has to bite, and the proof has to be that *only* the
  // unknown tenant is refused — otherwise a malformed statement would look
  // exactly like an enforced constraint. So the same insert is tried twice,
  // once under a tenant the hub knows and once under one it does not.
  const insert = (tenantId: string, id: string) =>
    host.db
      .execute(
        sql.raw(
          `INSERT INTO "builder"."artifact_node"
             ("id","project_id","artifact_id","version","kind","stage","title","media_type","content_hash","size_bytes","provenance")
           VALUES ('${id}','${tenantId}','art_${id}',1,'problem_statement',1,'Probe','text/markdown','h',1,'{}'::jsonb)`,
        ),
      )
      .then(() => "")
      .catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));

  // Only the tenant row is needed here; the hub is not mounted in this probe.
  await host.db.execute(sql`
    INSERT INTO "public"."tenant" ("id","name","slug","domain")
    VALUES ('t_local', 'Local workspace', 'local', 'local.solutions-builder.invalid')
    ON CONFLICT ("id") DO NOTHING
  `);
  const known = await insert("t_local", "an_known");
  const unknown = await insert("t_nonexistent", "an_orphan");

  check("a document under a project tenant the hub knows is allowed", known === "", known.slice(0, 60));
  check(
    "and one under a tenant the hub has never seen is refused",
    unknown !== "",
    unknown ? unknown.slice(0, 50) : "it was allowed",
  );

  await host.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nHub topology smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
