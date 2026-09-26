/**
 * A project's tenants, as the client needs them (#29): the project's own,
 * where everything of its deploys and writes, and its parent -- the
 * workspace -- where a project opened before #29 may still have a
 * specialist running, a workflow living and artifacts recorded.
 *
 * Tenant rows never change parent or mail domain, so both are read once
 * per session and kept.
 */
import type { Transport } from "@intx/hub-client";
import { getTenant, type HubTenant } from "@solutions-builder/installer";

const tenants = new Map<string, Promise<HubTenant | null>>();

function tenantRow(transport: Transport, tenantId: string): Promise<HubTenant | null> {
  let pending = tenants.get(tenantId);
  if (!pending) {
    pending = getTenant(transport, tenantId).catch((cause: unknown) => {
      tenants.delete(tenantId);
      throw cause;
    });
    tenants.set(tenantId, pending);
  }
  return pending;
}

/** The tenant `tenantId` inherits from -- the workspace, for a project -- or null. */
export async function parentTenantOf(transport: Transport, tenantId: string): Promise<string | null> {
  return (await tenantRow(transport, tenantId))?.parentId ?? null;
}

/** Test seam: forget every cached tenant row. */
export function resetTenantCache(): void {
  tenants.clear();
}

function domainOfAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * The tenant whose mailbox a conversation with `address` is held in: the
 * one whose mail domain the address carries. A specialist deployed in the
 * project tenant answers at `<run>@<project domain>`; one deployed before
 * #29 answers at the workspace's domain, and its thread is in the
 * workspace mailbox. `tenantId` itself when the domain is neither -- the
 * hub then says so, rather than this guessing.
 */
export async function mailTenantFor(transport: Transport, tenantId: string, address: string): Promise<string> {
  const domain = domainOfAddress(address);
  if (!domain) return tenantId;
  const own = await tenantRow(transport, tenantId).catch(() => null);
  if (own?.domain?.toLowerCase() === domain) return tenantId;
  const parentId = own?.parentId ?? null;
  if (!parentId) return tenantId;
  const parent = await tenantRow(transport, parentId).catch(() => null);
  return parent?.domain?.toLowerCase() === domain ? parentId : tenantId;
}

/** `addresses` grouped by the tenant their thread is read from (`mailTenantFor`). */
export async function addressesByMailTenant(
  transport: Transport,
  tenantId: string,
  addresses: readonly string[],
): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>();
  for (const address of addresses) {
    const tenant = await mailTenantFor(transport, tenantId, address);
    const group = groups.get(tenant);
    if (group) group.push(address);
    else groups.set(tenant, [address]);
  }
  return groups;
}
