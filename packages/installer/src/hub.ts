/**
 * A generic client for the Interchange hub's own HTTP API, built on nothing
 * but the platform's `Transport` — the same interface a browser tab and this
 * host's embedded dispatch both already implement. `apps/hub/src/hub-client.ts`
 * has a richer, typed version of most of this for the host's own use; this
 * one exists because the installer package may not import that file (it is
 * `apps/hub/src`, off limits from `packages/installer/src`), so the handful
 * of calls `install()` and `createProject()` need are rebuilt here directly
 * on `Transport`, once, rather than duplicated per call site.
 */
import {
  ApiError,
  deployWorkflow,
  listWorkflowDeployments,
  type DeployWorkflowInput,
  type Transport,
  type WorkflowDeployment,
} from "@intx/hub-client";
import { SOLUTIONS_BUILDER_APP, assertMayMintGrant } from "@solutions-builder/app/grant-namespaces";

export { ApiError };
export type HubDeployment = WorkflowDeployment;

/** The tenant this app installs into; found again by slug on every launch. */
export const WORKSPACE_SLUG = "solutions-builder";
/** The tenant id workspaces carried before the hub owned identity. */
export const LEGACY_TENANT_ID = "t_local";

function tenantPathFor(scope: string, rest: string): string {
  return `/api/tenants/${scope}${rest}`;
}

type Page<T> = { data: T[]; nextCursor: string | null };

/** Every page of a cursor-paginated list. */
async function list<T>(transport: Transport, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const page: Page<T> = await transport.fetch<Page<T>>(
      "GET",
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

// --- The workspace ---------------------------------------------------------

export type Workspace = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly userId: string;
};

type Membership = {
  principalId: string;
  tenantId: string;
  tenantSlug: string;
  kind: string;
  status: string;
};

/**
 * Finds the workspace the signed-in owner belongs to: the tenant with this
 * app's slug, or the tenant a workspace carried before the hub owned
 * identity. `null` when the owner holds no such tenant yet.
 */
export async function resolveWorkspace(transport: Transport): Promise<Workspace | null> {
  const user = await transport.fetch<{ id: string } | null>("GET", "/api/me").catch(() => null);
  if (!user) return null;
  const memberships = await list<Membership>(transport, "/api/me/principals");
  const mine = memberships.filter((entry) => entry.kind === "user" && entry.status === "active");
  const chosen =
    mine.find((entry) => entry.tenantSlug === WORKSPACE_SLUG) ??
    mine.find((entry) => entry.tenantId === LEGACY_TENANT_ID);
  if (!chosen) return null;
  return { tenantId: chosen.tenantId, principalId: chosen.principalId, userId: user.id };
}

/** Creates the workspace tenant; the hub makes the signed-in owner its principal. */
export async function createWorkspace(transport: Transport): Promise<Workspace> {
  await transport.fetch("POST", "/api/tenants", { name: "Solutions Builder", slug: WORKSPACE_SLUG });
  const resolved = await resolveWorkspace(transport);
  if (!resolved) throw new Error("The hub created the workspace but does not list it.");
  return resolved;
}

// --- Tenants -----------------------------------------------------------------

export type HubTenant = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  config?: Record<string, unknown>;
  createdAt: string;
};

/** A tenant under `parentId`; the hub makes the signed-in owner its first principal. */
export async function createChildTenant(
  transport: Transport,
  parentId: string,
  input: { name: string; slug: string },
): Promise<HubTenant> {
  return transport.fetch<HubTenant>("POST", "/api/tenants", { ...input, parentId });
}

export async function getTenant(transport: Transport, scope: string): Promise<HubTenant | null> {
  try {
    return await transport.fetch<HubTenant>("GET", `/api/tenants/${scope}`);
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 404 || cause.status === 403)) return null;
    throw cause;
  }
}

export async function patchTenant(
  transport: Transport,
  scope: string,
  input: { name?: string; config?: Record<string, unknown> },
): Promise<HubTenant> {
  return transport.fetch<HubTenant>("PATCH", `/api/tenants/${scope}`, input);
}

/** The signed-in owner's own principal in a tenant they belong to, or null. */
export async function myPrincipalIn(transport: Transport, scope: string): Promise<string | null> {
  const memberships = await list<Membership>(transport, "/api/me/principals");
  const mine = memberships.find(
    (entry) => entry.tenantId === scope && entry.kind === "user" && entry.status === "active",
  );
  return mine?.principalId ?? null;
}

// --- Roles, grants and authority -----------------------------------------

export type HubRole = { id: string; name: string; description: string | null; isSystem: boolean };

export async function listRoles(transport: Transport, scope: string): Promise<HubRole[]> {
  return list<HubRole>(transport, tenantPathFor(scope, "/roles"));
}

/** The role with this name in `scope`, created if the tenant does not have it. */
export async function ensureRole(
  transport: Transport,
  scope: string,
  name: string,
  description: string,
): Promise<HubRole> {
  const existing = (await listRoles(transport, scope)).find((role) => role.name === name);
  if (existing) return existing;
  return transport.fetch<HubRole>("POST", tenantPathFor(scope, "/roles"), { name, description });
}

/** Gives a principal a role. Already holding it is not an error. */
export async function assignRole(
  transport: Transport,
  scope: string,
  principalId: string,
  roleId: string,
): Promise<void> {
  try {
    await transport.fetch("POST", tenantPathFor(scope, `/principals/${principalId}/roles/${roleId}`));
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) return;
    throw cause;
  }
}

export type HubGrant = {
  id: string;
  roleId: string | null;
  principalId: string | null;
  resource: string;
  action: string;
  effect: "allow" | "deny" | "ask";
  origin: string;
};

export async function listGrants(transport: Transport, scope: string): Promise<HubGrant[]> {
  return list<HubGrant>(transport, tenantPathFor(scope, "/grants"));
}

/** A grant on a role in `scope`, created once. */
export async function ensureRoleGrant(
  transport: Transport,
  scope: string,
  input: { roleId: string; resource: string; action: string; effect: HubGrant["effect"]; origin: "system" | "role" },
): Promise<HubGrant> {
  // Refused before the scope is even resolved: an out-of-namespace mint never
  // reaches the hub, installed or not.
  assertMayMintGrant(SOLUTIONS_BUILDER_APP, input.resource);
  const grants = await listGrants(transport, scope);
  const existing = grants.find(
    (grant) =>
      grant.roleId === input.roleId &&
      grant.resource === input.resource &&
      grant.action === input.action &&
      grant.effect === input.effect,
  );
  if (existing) return existing;
  return transport.fetch<HubGrant>("POST", tenantPathFor(scope, "/grants"), input);
}

export type PrincipalGrantInput = {
  principalId: string;
  resource: string;
  action: string;
  effect: HubGrant["effect"];
  origin: "system" | "role" | "creator" | "invoker";
};

/** A grant on a principal: delegation carries a chosen credential into a project tenant on this. */
export async function createPrincipalGrant(
  transport: Transport,
  scope: string,
  input: PrincipalGrantInput,
): Promise<HubGrant> {
  return transport.fetch<HubGrant>("POST", tenantPathFor(scope, "/grants"), input);
}

/** Removes one grant by id; revocation deletes only what the delegation minted. */
export async function deleteGrant(transport: Transport, scope: string, grantId: string): Promise<void> {
  try {
    await transport.fetch("DELETE", tenantPathFor(scope, `/grants/${grantId}`));
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return;
    throw cause;
  }
}

// --- Workflow definitions (read side) --------------------------------------

export type HubDefinition = { id: string; name: string; createdAt: string };

export async function listDefinitions(transport: Transport, scope: string): Promise<HubDefinition[]> {
  return list<HubDefinition>(transport, tenantPathFor(scope, "/workflows/definitions"));
}

/**
 * The current definition for a name in `scope`, or `null` if none is
 * installed. "Current" is the newest row, so a fresh session keys to it.
 */
export async function definitionIdFor(transport: Transport, scope: string, name: string): Promise<string | null> {
  const rows = (await listDefinitions(transport, scope)).filter((row) => row.name === name);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return rows[0]?.id ?? null;
}

// --- The model catalog -----------------------------------------------------

export type HubCredential = {
  id: string;
  providerId: string;
  name: string;
  type: string;
  status: string;
  principalId: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: string;
};

export type HubModelProvider = {
  id: string;
  name: string;
  plugin: string;
  baseURL: string;
  credentialId: string | null;
  disabled: boolean;
};

export type HubModel = { id: string; canonicalName: string; displayName: string | null };

export type HubOffering = {
  id: string;
  modelId: string;
  providerId: string;
  priority: number;
  capabilities: string[];
  quirks: Record<string, unknown> | null;
  disabled: boolean;
};

export function catalogFor(transport: Transport, scope: string) {
  return {
    credentials: () => list<HubCredential>(transport, tenantPathFor(scope, "/credentials")),
    modelProviders: () => list<HubModelProvider>(transport, tenantPathFor(scope, "/catalog/providers")),
    models: () => list<HubModel>(transport, tenantPathFor(scope, "/catalog/models")),
    offerings: () => list<HubOffering>(transport, tenantPathFor(scope, "/catalog/offerings")),
  };
}

// --- Assets ------------------------------------------------------------------

export type HubAsset = { id: string; tenantId: string; kind: string; name: string };

export function assetsFor(transport: Transport, scope: string) {
  return {
    // Bare array, not a page: this route does not paginate.
    list: (kind: string) => transport.fetch<HubAsset[]>("GET", tenantPathFor(scope, `/assets?kind=${kind}`)),
    create: (input: { kind: string; name: string; displayName?: string }) =>
      transport.fetch<HubAsset>("POST", tenantPathFor(scope, "/assets"), input),
  };
}

// --- Workflow deployments ----------------------------------------------------

export function workflowsFor(transport: Transport, scope: string) {
  return {
    deployments: () => listWorkflowDeployments(transport, scope),
    deploy: (input: DeployWorkflowInput) => deployWorkflow(transport, scope, input),
  };
}
