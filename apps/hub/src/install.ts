/**
 * Installing the app into the workspace.
 *
 * The hub boots vanilla: migrate, mount, serve. Everything that makes it
 * *Solutions Builder* — the owner as a hub user with a tenant, human roles
 * and grants, project authority, the one lifecycle definition row the command
 * ledger's session keys on, and the per-project lifecycle deployment — is
 * installed here, on the client's request, as the owner, through the hub's
 * API. First run and upgrade are the same call, and it is idempotent, so the
 * client can ask again whenever a credential changes.
 *
 * "Installed" is a comparison, not a marker: every definition the package
 * generates exists in the tenant at the hash it would deploy right now.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import {
  assignRole,
  createWorkspace,
  definitionIdFor,
  ensureOwner,
  ensureRole,
  ensureRoleGrant,
  forgetWorkspace,
  hubGet,
  hubMode,
  ownerPrincipalId,
  resolveWorkspace,
  type Workspace,
} from "./hub-client.js";
import { adoptLegacyWorkspace } from "./hub-gaps.js";
import { expectedWorkflowDefinitions, seedWorkflows } from "./workflow-seed.js";
import { installProjectAuthority, listProjectRecords } from "./project-tenant.js";
import { ensureSkillAssets } from "./skill-assets.js";
import { rerankCatalogProviders } from "./catalog.js";
import { ensureLifecycleDeployment } from "./workflow-deploy.js";
import { migrateLegacyProviderCredentials } from "./credential-migration.js";

export type InstallState = {
  readonly installed: boolean;
  readonly appVersion: string;
  /** Definition names the tenant does not hold at all. */
  readonly missing: string[];
  /** Definition names the tenant holds at a different hash than the package generates. */
  readonly stale: string[];
  /**
   * The lifecycle as a hub deployment: `deployed` or `current` once the hub
   * holds it, `no_offering` until a provider is connected, `failed` with the
   * hub's reason otherwise. The in-process executor still drives stages
   * until stage gates move onto this deployment's run.
   */
  readonly deployment: { status: string; detail: string };
  readonly detail: string;
};

// The most recent deployment outcome; installState() is a read and must not deploy.
let lastDeployment: { status: string; detail: string } = { status: "missing", detail: "Not installed yet." };

const ROLE_DESCRIPTIONS: Record<string, string> = {
  project_owner: "Opens a project, approves stages and accepts delivery.",
  budget_approver: "Approves a firm estimate before any spend is committed.",
  technical_approver: "Approves a plan on technical grounds.",
  audience_member: "Records a proceed, revise or reject on an audience package.",
  builder_operator: "Answers a build's questions and decides its permissions.",
  delivery_recipient: "Accepts or rejects the delivered software.",
  system: "The host acting on its own behalf; never a human decision.",
};

export async function installState(): Promise<InstallState> {
  if (hubMode() !== "embedded") {
    // A hosted hub owns its tenants and definitions; installing into it is
    // that hub's lifecycle, not this process's.
    return {
      installed: true,
      appVersion: APP_VERSION,
      missing: [],
      stale: [],
      deployment: { status: "hosted", detail: "Managed by the hub." },
      detail: "Hosted hub: definitions are managed there.",
    };
  }
  const expected = await expectedWorkflowDefinitions();
  if (!(await resolveWorkspace())) {
    return {
      installed: false,
      appVersion: APP_VERSION,
      missing: expected.map((entry) => entry.name),
      stale: [],
      deployment: { status: "missing", detail: "No workspace yet." },
      detail: "No workspace yet.",
    };
  }
  const missing: string[] = [];
  const stale: string[] = [];
  for (const entry of expected) {
    const current = await definitionIdFor(entry.name);
    if (current === null) missing.push(entry.name);
    else if (current !== entry.id) stale.push(entry.name);
  }
  const installed = missing.length === 0 && stale.length === 0;
  return {
    installed,
    appVersion: APP_VERSION,
    missing,
    stale,
    deployment: lastDeployment,
    detail: installed
      ? `Installed ${APP_VERSION}.`
      : missing.length > 0
        ? `${missing.length} definitions missing.`
        : `${stale.length} definitions out of date.`,
  };
}

/**
 * The owner as a hub user, in a tenant that is theirs. Creates neither twice.
 * A workspace from before the hub owned identity is adopted rather than
 * abandoned, so its projects keep their tenant.
 */
export async function ensureWorkspace(): Promise<Workspace | null> {
  if (hubMode() !== "embedded") return resolveWorkspace();
  await ensureOwner();
  const found = await resolveWorkspace();
  if (found) {
    await migrateCredentialsOnce();
    return found;
  }
  // The owner exists but holds no tenant: a fresh install, or a legacy one.
  const me = await hubGet<{ id: string }>("/api/me");
  if (await adoptLegacyWorkspace(me.id)) {
    forgetWorkspace();
    const adopted = await resolveWorkspace();
    if (adopted) {
      await migrateCredentialsOnce();
      return adopted;
    }
  }
  const created = await createWorkspace();
  await migrateCredentialsOnce();
  return created;
}

/**
 * CL-8076: the one-time carry of a pre-upgrade keychain/file provider secret
 * into the hub's own credential row (`credential-migration.ts`). Runs once
 * the workspace is resolvable — it needs `tenantId()` and the catalog API —
 * and is safe to call on every `ensureWorkspace`: an old store already
 * emptied by a prior run has nothing left to carry.
 */
async function migrateCredentialsOnce(): Promise<void> {
  const result = await migrateLegacyProviderCredentials().catch((cause: unknown) => {
    // A per-account failure is already caught and reported inside
    // `migrateLegacyProviderCredentials`; this only catches something that
    // failed before any account could be tried (the tenant or catalog reads
    // themselves), so the rest of install still proceeds.
    console.error(
      `[credential-migration] could not carry legacy provider secrets forward: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  });
  if (result && result.failures.length > 0) {
    console.error(
      `[credential-migration] ${result.failures.length} legacy account(s) could not be migrated ` +
        `this run and will be retried on the next boot: ` +
        result.failures.map((failure) => `${failure.account} (${failure.error})`).join("; "),
    );
  }
}

/** Everything the tenant needs, in dependency order. Safe to run any time. */
export async function install(): Promise<InstallState> {
  if (hubMode() !== "embedded") return installState();

  await ensureWorkspace();
  await seedWorkflows();

  // Authority is the platform's: the ledger's authorities become roles, and
  // the owner holds every human one.
  const roles = new Map<string, string>();
  for (const name of AUTHORITIES) {
    const role = await ensureRole(name, ROLE_DESCRIPTIONS[name] ?? "");
    roles.set(name, role.id);
  }
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    // Role membership becomes a real platform grant `@intx/authz` can answer
    // for, not a "role name equals authority name" assumption in a reader.
    await ensureRoleGrant({
      roleId: roles.get(name)!,
      resource: `authority:${name}`,
      action: "hold",
      effect: "allow",
      origin: "role",
    });
    await assignRole(ownerPrincipalId(), roles.get(name)!);
  }

  // Every project is a tenant of its own with the same roles; a project opened
  // before roles lived there gets them here.
  for (const project of await listProjectRecords()) {
    await installProjectAuthority(project.id, project.policy);
  }
  await ensureSkillAssets();
  // A provider connected before its listing was read for what can answer
  // may still lead with a model that cannot; its offerings are put in order.
  await rerankCatalogProviders();

  // Model bindings are the catalog rows written when a provider connects, so
  // there is nothing to rebind here; re-running after a credential change is
  // what lets the lifecycle deploy once an offering exists to bind against.
  void deployLifecycle();
  return installState();
}

// The hub answers a deploy only after its probe sidecar has evaluated the
// source, which takes as long as spawning a process. Install returns at once
// and installState() reports "deploying" until the hub has answered.
let deploying: Promise<void> | null = null;
export function deployLifecycle(): Promise<void> {
  if (deploying) return deploying;
  lastDeployment = { status: "deploying", detail: "The hub is probing the lifecycle source." };
  deploying = ensureLifecycleDeployment()
    .then((deployed) => {
      lastDeployment =
        deployed.status === "no_offering"
          ? { status: "no_offering", detail: "Connect a provider to deploy the lifecycle." }
          : deployed.status === "no_host"
            ? { status: "no_host", detail: "The host is not serving, so no sidecar can dial in." }
            : { status: deployed.status, detail: `${deployed.deploymentId} is ${deployed.deploymentStatus}.` };
    })
    .catch((cause: unknown) => {
      lastDeployment = { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
    })
    .finally(() => {
      deploying = null;
    });
  return deploying;
}
