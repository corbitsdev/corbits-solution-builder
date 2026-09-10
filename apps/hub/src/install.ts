/**
 * Installing the app into the workspace.
 *
 * The hub boots vanilla: migrate, mount, serve. Everything that makes it
 * *Solutions Builder* — the owner principal, the workflow definitions generated
 * from the ledger, the roles and agent bindings, the specialist prompts in the
 * registry — is installed here, on the client's request, after boot. First run
 * and upgrade are the same call, and it is idempotent, so the client can ask
 * again whenever a credential changes.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { agentFor } from "@solutions-builder/app/kit";
import { hubMode } from "./hub-endpoint.js";
import { getWorkflowDefinitionId } from "./hub-workflows.js";
import { expectedWorkflowDefinitions } from "./workflow-seed.js";
import { ensureWorkspace, LOCAL_TENANT } from "./projects.js";

export type InstallState = {
  readonly installed: boolean;
  readonly appVersion: string;
  /** Definition names the tenant does not hold at all. */
  readonly missing: string[];
  /** Definition names the tenant holds at a different hash than the package generates. */
  readonly stale: string[];
  readonly detail: string;
};

export const OWNER = { principalId: "p_owner", displayName: "You" } as const;

export async function installState(): Promise<InstallState> {
  if (hubMode() !== "embedded") {
    // A hosted hub owns its tenants and definitions; installing into it is
    // that hub's lifecycle, not this process's. Nothing to do here, and saying
    // so beats pretending to.
    return {
      installed: true,
      appVersion: APP_VERSION,
      missing: [],
      stale: [],
      detail: "Hosted hub: definitions are managed there.",
    };
  }
  // Installed is a comparison, not a marker: every definition the package
  // generates exists in the tenant at the hash it would deploy right now.
  const missing: string[] = [];
  const stale: string[] = [];
  for (const expected of await expectedWorkflowDefinitions()) {
    const current = await getWorkflowDefinitionId(LOCAL_TENANT, expected.name);
    if (current === null) missing.push(expected.name);
    else if (current !== expected.id) stale.push(expected.name);
  }
  const installed = missing.length === 0 && stale.length === 0;
  return {
    installed,
    appVersion: APP_VERSION,
    missing,
    stale,
    detail: installed
      ? `Installed ${APP_VERSION}.`
      : missing.length > 0
        ? `${missing.length} definitions missing.`
        : `${stale.length} definitions out of date.`,
  };
}

/** Everything the tenant needs, in dependency order. Safe to run any time. */
export async function install(): Promise<InstallState> {
  if (hubMode() !== "embedded") return installState();

  await ensureWorkspace(OWNER);

  const { seedWorkflows } = await import("./workflow-seed.js");
  const seeded = await seedWorkflows();

  // Authority is the platform's: the ledger's authorities become roles, the
  // owner holds them, and every stage definition is bound to `specialist`,
  // the role that approves nothing.
  const { seedRoles } = await import("./hub-roles.js");
  await seedRoles({
    ownerPrincipalId: OWNER.principalId,
    agentDefinitionIds: seeded
      .filter((entry) => entry.name.startsWith("solutions-builder.stage."))
      .map((entry) => entry.id),
  });

  // The prompt a specialist reads is a commit in the hub's own repo for that
  // definition, which is where a sidecar pulls it from.
  const { deployDefinitionBodies } = await import("./hub-deploy.js");
  await deployDefinitionBodies(
    seeded
      .filter((entry) => /\.stage\.\d+$/.test(entry.name))
      .map((entry) => ({
        definitionId: entry.id,
        systemPrompt: agentFor(Number(entry.name.split(".").at(-1)) as never).system,
      })),
  );

  // Model bindings are the catalog rows written when a provider connects, so
  // there is nothing to rebind here; re-running after a credential change
  // exists so the definitions and roles are present for it to bind against.
  return installState();
}
