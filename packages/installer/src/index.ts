/**
 * The public surface of `@solutions-builder/installer`.
 *
 * Everything here is driven by a `Transport` (`@intx/hub-client`) already
 * authenticated as the signed-in principal. This package never reaches a
 * database or an Interchange internal itself; every platform write goes
 * through a real hub route.
 */
export * from "./artifacts.js";
export * from "./authority-grants.js";
export * from "./catalog-seed.js";
export * from "./designer-settings.js";
export * from "./errors.js";
export * from "./git-push.js";
export * from "./grant-holders.js";
export * from "./hub.js";
export * from "./tenants.js";
export * from "./assets.js";
export * from "./install.js";
export * from "./model-default.js";
export * from "./project-tenant.js";
export * from "./provider-connect.js";
export * from "./registry-tarballs.js";
export * from "./tarball-extract.js";
export * from "./workbench-delegation.js";
export * from "./workflow-closure.js";
export * from "./workflow-deploy.js";
export * from "./skill-assets.js";
export * from "./specialist-deploy.js";
export * from "./project-workflow-deploy.js";

import type { Transport } from "@intx/hub-client";
import {
  createProjectRecord,
  type DelegationRecord,
  type ProjectPolicy,
  type ProjectRecord,
} from "./project-tenant.js";
import {
  delegateAtCreation,
  liveDelegationStore,
  resolveDelegationConsent,
  revokeAllDelegations,
} from "./workbench-delegation.js";

/**
 * Opens a project: the child tenant, its authority, and the credential
 * delegation the creation payload consented to. This is the installer's
 * `createProject` — the tenant-and-grant half of opening a project. The
 * ledger's own `project.create` command (the run it opens, the command it
 * records) stays the host's: `apps/hub/src/projects.ts` calls this first,
 * then does that.
 */
export async function createProject(
  transport: Transport,
  workspaceTenantId: string,
  args: { title: string; slug: string; policy: ProjectPolicy; delegatedCredentialIds?: string[] },
): Promise<{ project: ProjectRecord; delegations: DelegationRecord }> {
  const store = liveDelegationStore(transport, workspaceTenantId);
  const consent = resolveDelegationConsent(args.delegatedCredentialIds, await store.listDelegatableCredentials());

  const project = await createProjectRecord(transport, workspaceTenantId, {
    title: args.title,
    slug: args.slug,
    policy: args.policy,
  });
  try {
    const delegations = await delegateAtCreation(store, { projectId: project.id, consent });
    return { project, delegations };
  } catch (cause) {
    // The tenant exists but the project never opened: pull back whatever the
    // delegation minted so a failed creation leaves no orphan grant behind.
    // The tenant row itself is the caller's to conceal — it knows how a
    // project is marked deleted (`updateProject`) and whether that is even
    // this package's job for a tenant it just failed to finish opening.
    await revokeAllDelegations(store, project.id).catch(() => {
      // Best effort: the cause below is what the caller needs to see.
    });
    throw cause;
  }
}
