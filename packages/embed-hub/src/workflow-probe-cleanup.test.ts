import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createWorkflowProbeStore, type DB } from "@intx/db";
import * as intxSchema from "@intx/db/schema";
import { createSidecarPluginRegistry, createWorkflowAllocationService, type SidecarProvisioner } from "@intx/hub-sessions";
import { withPostgresJsResultShape } from "./pg-compat.js";

// #315: a releasing probe bound under the Workbench provisioner's binding
// (`process:v1:probe:<entry>:<hub url>`) can never match the Interchange-
// native provisioner (`process:v1:probe`); cleanup used to throw on every
// tick forever. The vendored patch finishes it as failed instead.

async function openDb(): Promise<DB["db"]> {
  const db = withPostgresJsResultShape(drizzle(new PGlite(), { schema: intxSchema })) as unknown as DB["db"];
  // Only the probe table, without its foreign keys into tenant/asset/sidecar.
  await db.execute(sql`CREATE TABLE "workflow_probe" (
    "id" text PRIMARY KEY, "tenant_id" text NOT NULL, "definition_asset_id" text NOT NULL,
    "source" jsonb NOT NULL, "entry" text NOT NULL, "pin" text, "status" text NOT NULL DEFAULT 'pending',
    "provisioner_id" text NOT NULL, "provisioner_api_version" integer NOT NULL,
    "provisioner_binding_fingerprint" text NOT NULL, "sidecar_id" text, "generation" integer NOT NULL DEFAULT 0,
    "external_ref" text, "result" jsonb, "failure_code" text, "failure_message" text,
    "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now())`);
  return db;
}

function provisioner(fingerprint: string, destroyed: string[]): SidecarProvisioner {
  return {
    id: "process",
    apiVersion: 1,
    bindingFingerprint: fingerprint,
    capabilities: [],
    ensure: async () => ({ kind: "rejected", code: "unused", message: "unused", retryable: false }),
    destroy: async (request: { sidecarId: string }) => {
      destroyed.push(request.sidecarId);
      return { kind: "destroyed" };
    },
  } as unknown as SidecarProvisioner;
}

async function serviceWith(db: DB["db"], fingerprint: string) {
  const destroyed: string[] = [];
  const retired: string[] = [];
  const plugins = createSidecarPluginRegistry({ provisioners: [provisioner(fingerprint, destroyed)] });
  const service = createWorkflowAllocationService({
    db,
    deploymentPlugins: plugins,
    probePlugins: plugins,
    preparedDeployer: {} as never,
    credentialCipher: {} as never,
    allocationRouter: {
      disconnectAllocation: () => undefined,
      fenceAllocation: () => undefined,
      isAllocatedWorkflowActive: () => false,
      retireAllocation: ({ allocationId }: { allocationId: string }) => {
        retired.push(allocationId);
      },
      sendProbeToAllocation: async () => undefined,
      waitForAllocatedSidecar: async () => undefined,
    } as never,
    hubWebSocketUrl: "ws://127.0.0.1:1/api/sidecars/ws",
  });
  return { service, destroyed, retired };
}

async function releasingProbe(db: DB["db"], id: string, fingerprint: string) {
  const store = createWorkflowProbeStore(db);
  await store.create({
    id,
    tenantId: "tnt_1",
    definitionAssetId: "ast_1",
    source: { kind: "tarball", url: "https://example.test/x.tgz" } as never,
    entry: "index.ts",
    provisionerId: "process",
    provisionerApiVersion: 1,
    provisionerBindingFingerprint: fingerprint,
  });
  await db.execute(sql`UPDATE "workflow_probe" SET "status" = 'releasing', "sidecar_id" = ${`sc_${id}`} WHERE "id" = ${id}`);
  return store;
}

describe("reconcileReleasingProbes", () => {
  test("a probe bound under a binding no provisioner matches is finished as failed and retired, not thrown", async () => {
    const db = await openDb();
    const store = await releasingProbe(db, "wpr_old", "process:v1:probe:/old/checkout/sidecar/index.ts:ws://127.0.0.1:50839/api/sidecars/ws");
    const { service, destroyed, retired } = await serviceWith(db, "process:v1:probe");
    await service.reconcileReleasingProbes!();
    const after = await store.get("wpr_old");
    expect(after?.status).toBe("failed");
    expect(after?.failureCode).toBe("provisioner_unavailable");
    expect(after?.failureMessage).toContain("process:v1:probe:/old/checkout");
    expect(destroyed).toEqual([]);
    expect(retired).toEqual(["wpr_old"]);
    // And the next tick has nothing left to fail on.
    await service.reconcileReleasingProbes!();
    expect(await store.listReleasing()).toEqual([]);
  });

  test("a probe the registered provisioner does match is destroyed and succeeds as before", async () => {
    const db = await openDb();
    const store = await releasingProbe(db, "wpr_new", "process:v1:probe");
    const { service, destroyed, retired } = await serviceWith(db, "process:v1:probe");
    await service.reconcileReleasingProbes!();
    expect((await store.get("wpr_new"))?.status).toBe("succeeded");
    expect(destroyed).toEqual(["sc_wpr_new"]);
    expect(retired).toEqual(["wpr_new"]);
  });
});
