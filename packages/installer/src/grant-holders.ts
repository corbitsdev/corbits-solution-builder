/**
 * Who holds a grant in a tenant, addressed for `@corbits/mailbox`.
 *
 * A grant lands on a role or directly on a principal (`./hub.ts`'s
 * `HubGrant`); this resolves either into the principals actually holding it
 * — the same combination `authority-grants.ts`'s `ensureAuthorityGrants` mints
 * against — each addressed as `<refId>@<tenant.domain>`, the same address
 * `packages/embed-hub/src/index.ts`'s mailbox mount resolves a sender by.
 */
import type { Transport } from "@intx/hub-client";
import { getTenant, listGrants } from "./hub.js";

type PrincipalRow = {
  readonly id: string;
  readonly refId: string;
  readonly roles: readonly { readonly id: string; readonly name: string }[];
};

type PrincipalsPage = { readonly data: readonly PrincipalRow[]; readonly nextCursor: string | null };

async function listPrincipals(transport: Transport, scope: string): Promise<readonly PrincipalRow[]> {
  const rows: PrincipalRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page: PrincipalsPage = await transport.fetch<PrincipalsPage>(
      "GET",
      `/api/tenants/${scope}/principals?limit=100${suffix}`,
    );
    rows.push(...page.data);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return rows;
}

export type GrantHolder = { readonly principalId: string; readonly address: string };

/**
 * Every principal in `scope` holding an `allow` grant for `resource`/`action`
 * — directly, or through a role it is assigned. Empty when the tenant has no
 * `domain` to address them by (should not happen for a live tenant).
 */
export async function grantHolders(
  transport: Transport,
  scope: string,
  resource: string,
  action: string,
): Promise<readonly GrantHolder[]> {
  const [grants, principals, tenant] = await Promise.all([
    listGrants(transport, scope),
    listPrincipals(transport, scope),
    getTenant(transport, scope),
  ]);
  const domain = (tenant as unknown as { domain?: string } | null)?.domain;
  if (!domain) return [];

  const relevant = grants.filter((grant) => grant.effect === "allow" && grant.resource === resource && grant.action === action);
  const grantedPrincipalIds = new Set(relevant.map((grant) => grant.principalId).filter((id): id is string => id !== null));
  const grantedRoleIds = new Set(relevant.map((grant) => grant.roleId).filter((id): id is string => id !== null));

  const holders: GrantHolder[] = [];
  for (const row of principals) {
    const holds = grantedPrincipalIds.has(row.id) || row.roles.some((role) => grantedRoleIds.has(role.id));
    if (holds) holders.push({ principalId: row.id, address: `${row.refId}@${domain}` });
  }
  return holders;
}
