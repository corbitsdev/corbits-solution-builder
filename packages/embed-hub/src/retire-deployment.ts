/**
 * Retiring a deployment the installer has superseded: a replacement with
 * decision replay (#51), a stalled run's replacement (#192), a specialist's
 * model switch or stale-entry redeploy. The hub's own `DELETE /runs/:runId`
 * answers "unsupported" (INTR-454), so without this a superseded deployment
 * stays `running`, its allocation stays `allocated`, and after a restart the
 * reconciler keeps replacing its dead sidecar.
 *
 * This is the platform's own release path, run for a deployment instead of
 * for a sidecar the reconciler gave up on (`beginUnrecoverableRelease`):
 * the allocation moves to `releasing` under the generation it was read at,
 * the deployment's live runs fail and their principals are deactivated, and
 * its unsettled dispatches fail. The reconciler then destroys the sidecar
 * and marks the allocation `released`, as it does for any release.
 */
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AnyPgDatabase, SidecarAllocationStore, WorkflowRunDispatchStore } from "@intx/db";
import { liveWorkflowRunStatuses, principal, workflowRun } from "@intx/db/schema";
import { idResource, type RequireGrant, type TenantEnv } from "@intx/hub-api";

export const RETIRED_FAILURE_CODE = "deployment_superseded";
const RETIRED_FAILURE_MESSAGE = "Superseded by a newer deployment";

export type RetireOutcome = "released" | "not_found";

type RetireDeps = {
  readonly db: AnyPgDatabase;
  readonly allocationStore: Pick<SidecarAllocationStore, "findByAnchorRunId" | "beginRelease">;
  readonly dispatchStore: Pick<WorkflowRunDispatchStore, "failUnsettled">;
};

/** Releases `deploymentId` if it is an anchor run of `tenantId`; a deployment already released or releasing is left as it is. */
export async function retireDeployment(deps: RetireDeps, tenantId: string, deploymentId: string): Promise<RetireOutcome> {
  const { db, allocationStore, dispatchStore } = deps;
  const [anchor] = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(and(eq(workflowRun.id, deploymentId), eq(workflowRun.anchorRunId, workflowRun.id), eq(workflowRun.tenantId, tenantId)))
    .limit(1);
  if (anchor === undefined) return "not_found";

  // A reconciler step may move the allocation between the read and the
  // conditional write; the write is fenced on status and generation, so it
  // is simply read again.
  for (let attempt = 0; ; attempt += 1) {
    const allocation = await allocationStore.findByAnchorRunId(deploymentId);
    const status = allocation?.status;
    if (allocation === null || status === undefined || !isReleasable(status)) break;
    if (attempt === 5) throw new Error(`allocation ${allocation.id} kept moving; deployment ${deploymentId} was not retired`);
    const released = await db.transaction(async (tx) => {
      const now = new Date();
      const releasing = await allocationStore.beginRelease(
        {
          allocationId: allocation.id,
          expectedStatus: status,
          expectedGeneration: allocation.generation,
          failureCode: RETIRED_FAILURE_CODE,
          failureMessage: RETIRED_FAILURE_MESSAGE,
          now,
        },
        tx,
      );
      if (releasing === null) return false;
      await failLiveRuns(tx, deploymentId, now);
      await dispatchStore.failUnsettled(deploymentId, RETIRED_FAILURE_CODE, RETIRED_FAILURE_MESSAGE, now, tx);
      return true;
    });
    if (released) return "released";
  }
  // Nothing left to release -- already releasing or released, or never
  // placed -- but its runs must not stay live either way.
  await db.transaction((tx) => failLiveRuns(tx, deploymentId, new Date()));
  return "released";
}

function isReleasable(status: string): status is "pending" | "provisioning" | "allocated" | "replacing" {
  return status === "pending" || status === "provisioning" || status === "allocated" || status === "replacing";
}

// The same settlement `beginUnrecoverableRelease` makes for the runs it releases.
async function failLiveRuns(tx: Pick<AnyPgDatabase, "update">, anchorRunId: string, now: Date): Promise<void> {
  const failed = await tx
    .update(workflowRun)
    .set({ status: "failed", endedAt: now })
    .where(and(eq(workflowRun.anchorRunId, anchorRunId), inArray(workflowRun.status, [...liveWorkflowRunStatuses])))
    .returning({ principalId: workflowRun.principalId });
  const principalIds = failed.flatMap(({ principalId }) => (principalId === null ? [] : [principalId]));
  if (principalIds.length > 0) {
    await tx.update(principal).set({ status: "deactivated", updatedAt: now }).where(inArray(principal.id, principalIds));
  }
}

/**
 * `POST /:deploymentId` under `/api/tenants/:tenantId/deployment-retirements`:
 * the caller needs `manage` on the deployment's anchor run -- the grant
 * triggering it already takes -- and the deployment must be the tenant's own.
 */
export function createRetireDeploymentApi(deps: RetireDeps, requireGrant: RequireGrant) {
  const api = new Hono<TenantEnv>();
  api.post("/:deploymentId", requireGrant(idResource("workflow-run", "deploymentId"), "manage"), async (c) => {
    const outcome = await retireDeployment(deps, c.get("tenant").id, c.req.param("deploymentId"));
    if (outcome === "not_found") return c.json({ error: "Deployment not found" }, 404);
    return c.body(null, 204);
  });
  return api;
}
