/**
 * Where a project's things live (#29).
 *
 * A project is a child tenant of the workspace, and it is the tenant its
 * specialists, its project workflow and its artifacts are deployed and
 * written into: the hub then enforces what the product promises -- the
 * owner's delegation choice decides which workspace credentials a
 * specialist may use (`workbench-delegation.ts`), and one project's drafts
 * are not another's by tenant, not by a `metadata.sb.projectId` label.
 *
 * Projects opened before that was so left their specialists, workflow and
 * artifacts in the workspace tenant. Those are still read from there --
 * `legacyTenantId` is the workspace, the project's parent -- so an existing
 * project keeps its history, its stage and its drafts. Nothing new is ever
 * written there: a dead legacy deployment is revived in the project tenant
 * (with its history replayed), and every new artifact lands there too.
 */
import type { Transport } from "@intx/hub-client";
import { InstallerError } from "./errors.js";
import { getTenant, type HubTenant } from "./hub.js";

export type ProjectHome = {
  /** The project's own tenant: where everything of its deploys and writes. */
  readonly tenant: HubTenant;
  readonly tenantId: string;
  /** The workspace, for what an older project still has there. Null only
   *  for a tenant with no parent, which no project is. */
  readonly legacyTenantId: string | null;
  readonly legacyTenant: HubTenant | null;
};

export async function projectHome(transport: Transport, projectId: string): Promise<ProjectHome> {
  const tenant = await getTenant(transport, projectId);
  if (!tenant) throw new InstallerError("conflict", "That project was not found.");
  const legacyTenant = tenant.parentId ? await getTenant(transport, tenant.parentId) : null;
  return { tenant, tenantId: tenant.id, legacyTenantId: tenant.parentId ?? null, legacyTenant };
}

/** `tenantId` and, when there is one, the legacy workspace: the tenants a
 *  project's things can be found in, own first. */
export function projectTenants(home: Pick<ProjectHome, "tenantId" | "legacyTenantId">): string[] {
  return home.legacyTenantId ? [home.tenantId, home.legacyTenantId] : [home.tenantId];
}
