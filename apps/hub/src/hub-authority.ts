/**
 * Actor authority, resolved through the platform's own grant evaluator.
 *
 * `roles.ts` seeds a `role` per ledger `Authority`, grants the workspace owner
 * `principal_role` membership in each, and stamps every role with a
 * `grant` — `allow` on `authority:<name>/hold` — so role membership is a real
 * platform grant rather than a name this file assumes matches. Resolving "does
 * this principal hold budget_approver" means asking `@intx/authz` to evaluate
 * that grant through `createGrantStore`'s own role-membership join
 * (`principal_role` -> `grant.role_id`), the same path any other Interchange
 * grant resolves through — not a hand-written array membership test over a
 * Builder-only table.
 *
 * `system` is deliberately excluded: it is never a role a principal holds, it
 * is the host process's own authority (`engine.ts`'s `HOST_PRINCIPAL`), and
 * folding it in here would let it be granted the way a human authority is.
 */
import { authorize } from "@intx/authz";
import { createGrantStore } from "@intx/db";
import { hub } from "./hub-mount.js";
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import { LOCAL_TENANT } from "./projects.js";

const HUMAN_AUTHORITIES = AUTHORITIES.filter((name) => name !== "system");

/** The ledger authorities `principalId` actually holds, per the platform's grants. */
export async function authoritiesFor(principalId: string): Promise<Authority[]> {
  const store = createGrantStore(hub().db.db);
  const held: Authority[] = [];
  for (const name of HUMAN_AUTHORITIES) {
    const result = await authorize(store, principalId, LOCAL_TENANT, `authority:${name}`, "hold");
    if (result.effect === "allow") held.push(name);
  }
  return held;
}
