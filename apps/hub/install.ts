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
import { eq } from "drizzle-orm";
import { APP_VERSION, expectedDefinitions } from "@solutions-builder/app/manifest";
import { agentFor } from "@solutions-builder/app/kit";
import { database } from "./db.js";
import * as table from "./schema.js";
import { hubMode } from "./hub-endpoint.js";
import { getWorkflowDefinitionId } from "./hub-workflows.js";
import { ensureWorkspace, LOCAL_TENANT } from "./projects.js";

export type InstallState = {
  readonly installed: boolean;
  readonly appVersion: string;
  readonly installedVersion: string | null;
  /** Definition names the tenant does not hold yet. */
  readonly missing: string[];
  readonly detail: string;
};

export const OWNER = { principalId: "p_owner", displayName: "You" } as const;

/**
 * The installed version is one host preference row. Interchange has no
 * "installed app" record yet; when the lifecycle contract lands upstream this
 * moves onto it, and until then a preference is the smallest honest marker.
 */
const VERSION_KEY = "installed_app_version";

async function installedVersion(): Promise<string | null> {
  const { db } = database();
  const [row] = await db
    .select()
    .from(table.hostPreference)
    .where(eq(table.hostPreference.key, VERSION_KEY));
  return typeof row?.value === "string" ? row.value : null;
}

async function recordVersion(): Promise<void> {
  const { db } = database();
  const existing = await installedVersion();
  if (existing === null) {
    await db.insert(table.hostPreference).values({ key: VERSION_KEY, value: APP_VERSION });
    return;
  }
  if (existing !== APP_VERSION) {
    await db
      .update(table.hostPreference)
      .set({ value: APP_VERSION, updatedAt: new Date() })
      .where(eq(table.hostPreference.key, VERSION_KEY));
  }
}

export async function installState(): Promise<InstallState> {
  if (hubMode() !== "embedded") {
    // A hosted hub owns its tenants and definitions; installing into it is
    // that hub's lifecycle, not this process's. Nothing to do here, and saying
    // so beats pretending to.
    return {
      installed: true,
      appVersion: APP_VERSION,
      installedVersion: null,
      missing: [],
      detail: "Hosted hub: definitions are managed there.",
    };
  }
  const missing: string[] = [];
  for (const name of expectedDefinitions()) {
    if ((await getWorkflowDefinitionId(LOCAL_TENANT, name)) === null) missing.push(name);
  }
  const version = await installedVersion();
  const installed = missing.length === 0 && version === APP_VERSION;
  return {
    installed,
    appVersion: APP_VERSION,
    installedVersion: version,
    missing,
    detail: installed
      ? `Installed ${APP_VERSION}.`
      : missing.length > 0
        ? `${missing.length} definitions missing.`
        : version === null
          ? "Not installed."
          : `Installed ${version}, ${APP_VERSION} available.`,
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
  await recordVersion();
  return installState();
}
