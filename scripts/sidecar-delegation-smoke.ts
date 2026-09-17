/**
 * Sidecar smoke for CL-8136: a project tenant cannot use a workspace offering
 * until the owner delegates that credential, and a revoke is visible on the
 * next resolve — the same `resolveSourcesByOfferingIds` check the sidecar
 * re-runs when it next connects.
 *
 * Default creation records none. Delegating one workspace provider allows
 * the offering. Revoking it fails closed again. Catalog rows stay on the
 * workspace; nothing here copies them into the project, and the vendor
 * resolver is not rewritten.
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "sb-sidecar-delegation-"));
process.env["SOLUTIONS_BUILDER_DATA_DIR"] = dataDir;

const { openDatabase } = await import("../apps/hub/src/db.js");
const { prepareDatabase } = await import("../apps/hub/src/migrate.js");
const { hub, hubWebSocket, mountHub, setHostPort } = await import("../apps/hub/src/hub-mount.js");
const { install } = await import("./host-install.js");
const { createProjectRecord } = await import("../apps/hub/src/project-records.js");
const { liveDelegationStore, delegateAtCreation, delegateMore, revokeAllDelegations } = await import(
  "../apps/hub/src/project-delegation.js"
);
const { connectProvider } = await import("../apps/hub/src/providers.js");
const { catalog, myPrincipalIn } = await import("../apps/hub/src/hub-client.js");
const { resolveSourcesByOfferingIds } = await import("@intx/db");

const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const SECRET = "[redacted: looks like a credential]";

const stub = createServer((request, response) => {
  const authorized = (request.headers.authorization ?? "") === `Bearer ${SECRET}`;
  if (!authorized) {
    response.writeHead(401).end("{}");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "stub-large" }, { id: "stub-image" }] }));
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as { port: number }).port;

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

function describeResolution(result: Awaited<ReturnType<typeof resolveSourcesByOfferingIds>>): string {
  if (result.ok) return `${result.sources.length} sources`;
  return `${result.reason}${result.skip ? `:${result.skip.reason}` : ""}`;
}

try {
  await install();
  await connectProvider({
    providerId: "compatible",
    label: "Stub provider",
    kind: "api_key",
    secret: SECRET,
    baseUrl: `http://127.0.0.1:${stubPort}`,
  });

  const offerings = (await catalog.offerings())
    .filter((row) => !row.disabled)
    .sort((a, b) => a.priority - b.priority);
  const credentials = (await catalog.credentials()).filter((row) => row.principalId === null);
  const offeringIds = offerings.map((row) => row.id);
  const credentialId = credentials[0]?.id;
  check(
    "the workspace catalog has a tenant-owned credential and an offering to delegate",
    offeringIds.length > 0 && credentialId !== undefined,
    `${offerings.length} offerings, ${credentials.length} credentials`,
  );

  if (offeringIds.length > 0 && credentialId !== undefined) {
    const store = liveDelegationStore();
    const sealed = await createProjectRecord({
      title: "Smoke: sealed workbench",
      policy: {
        costTolerancePercent: 15,
        costToleranceAbsolute: 500,
        audiences: [],
        audienceQuorum: 0,
        allowExternalProviders: false,
      },
    });
    const consent = await delegateAtCreation(store, { projectId: sealed.id });
    check(
      "creation without a chosen set records the explicit default of none",
      consent.mode === "default" && consent.credentialIds.length === 0,
      `${consent.mode} [${consent.credentialIds.join(",")}]`,
    );

    const principalId = await myPrincipalIn(sealed.id);
    check("the owner has a principal in the project tenant", principalId !== null, principalId ?? "none");

    if (principalId) {
      const resolve = () =>
        resolveSourcesByOfferingIds(
          hub().db.db,
          sealed.id,
          offeringIds,
          hub().credentialCipher,
          principalId,
        );

      const denied = await resolve();
      check(
        "default delegation (no credentials) cannot run a stage against a workspace offering",
        !denied.ok && denied.reason === "offering_unavailable" && denied.skip?.reason === "credential_unauthorized",
        describeResolution(denied),
      );

      await delegateMore(store, { projectId: sealed.id, delegatedCredentialIds: [credentialId] });
      const allowed = await resolve();
      check(
        "delegating one workspace provider lets the project resolve that offering",
        allowed.ok,
        describeResolution(allowed),
      );

      await revokeAllDelegations(store, sealed.id);
      const revoked = await resolve();
      check(
        "revoking the delegation fails the next run's source resolution",
        !revoked.ok && revoked.reason === "offering_unavailable" && revoked.skip?.reason === "credential_unauthorized",
        describeResolution(revoked),
      );
    }
  }
} finally {
  stub.close();
  hub().stopReconcile();
  const { stopSpawnedSidecars } = await import("../apps/hub/src/sidecar-processes.js");
  await stopSpawnedSidecars(join(dataDir, "hub"));
  await server.stop(true);
  await host.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}

const passed = checks.filter((entry) => entry.ok).length;
console.log(`Sidecar delegation smoke: ${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
