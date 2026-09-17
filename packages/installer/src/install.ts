/**
 * Installing the app into the workspace.
 *
 * The hub boots vanilla: migrate, mount, serve. Everything that makes it
 * *Solutions Builder* — the owner as a hub user with a tenant, human roles
 * and grants, project authority, the one lifecycle definition row the command
 * ledger's session keys on, and the per-project lifecycle deployment — is
 * installed here, driven by a hub `Transport` already authenticated as the
 * signed-in principal. First run signs up or in against the hub, then this
 * call creates the workspace tenant as that session. First run and upgrade
 * are the same call, and it is idempotent, so the host can ask again whenever
 * a credential changes.
 *
 * "Installed" is a comparison, not a marker: every definition the package
 * generates exists in the tenant at the hash it would deploy right now.
 */
import type { Transport } from "@intx/hub-client";
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import { assignRole, createWorkspace, definitionIdFor, ensureRole, resolveWorkspace, type Workspace } from "./hub.js";
import { expectedWorkflowDefinitions, seedWorkflows } from "./workflow-seed.js";
import { installProjectAuthority, listProjectRecords } from "./project-tenant.js";
import { ensureAuthorityGrants } from "./signal-grants.js";
import { ensureSkillAssets } from "./skill-assets.js";
import { ensureLifecycleDeployment, type SidecarCapability } from "./workflow-deploy.js";

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
   * host's reason otherwise. The host's own in-process executor still drives
   * stages until stage gates move onto this deployment's run.
   */
  readonly deployment: { status: string; detail: string };
  readonly detail: string;
};

// The most recent deployment outcome; installState() is a read and must not deploy.
let lastDeployment: { status: string; detail: string } = { status: "missing", detail: "Not installed yet." };

// The resolved workspace, cached the same way the host's own tenant lookups
// are: found again by slug, forgotten by whoever creates or adopts a tenant.
let workspace: Workspace | null = null;

const ROLE_DESCRIPTIONS: Record<string, string> = {
  project_owner: "Opens a project, approves stages and accepts delivery.",
  budget_approver: "Approves a firm estimate before any spend is committed.",
  technical_approver: "Approves a plan on technical grounds.",
  audience_member: "Records a proceed, revise or reject on an audience package.",
  builder_operator: "Answers a build's questions and decides its permissions.",
  delivery_recipient: "Accepts or rejects the delivered software.",
  system: "The host acting on its own behalf; never a human decision.",
};

/** Forgets the cached workspace, so the next read asks the hub again. */
export function forgetWorkspace(): void {
  workspace = null;
}

export async function installState(transport: Transport): Promise<InstallState> {
  const expected = await expectedWorkflowDefinitions();
  const found = workspace ?? (await resolveWorkspace(transport));
  if (!found) {
    return {
      installed: false,
      appVersion: APP_VERSION,
      missing: expected.map((entry) => entry.name),
      stale: [],
      deployment: { status: "missing", detail: "No workspace yet." },
      detail: "No workspace yet.",
    };
  }
  workspace = found;
  const missing: string[] = [];
  const stale: string[] = [];
  for (const entry of expected) {
    const current = await definitionIdFor(transport, found.tenantId, entry.name);
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
 * The owner's tenant, resolved or created. Creates neither twice.
 *
 * A workspace from before the hub owned identity is the host's own concern:
 * `adoptLegacyWorkspace` (`apps/hub/src/hub-migrate.ts`) is a one-time
 * repair of pre-identity rows, not a hub route, so it cannot live in this
 * package (no `@intx/db`, ever). The host runs it once, before calling
 * `install`/`ensureWorkspace` at all, so a legacy tenant already resolves by
 * the time this looks.
 */
export async function ensureWorkspace(transport: Transport): Promise<Workspace> {
  const found = await resolveWorkspace(transport);
  if (found) {
    workspace = found;
    return found;
  }
  const created = await createWorkspace(transport);
  workspace = created;
  return created;
}

/**
 * Everything the tenant needs, in dependency order. Safe to run any time.
 *
 * `afterEnsureWorkspace` is CL-8076's one-time carry of a pre-upgrade
 * keychain/file provider secret into the hub's own credential row
 * (`apps/hub/src/credential-migration.ts`). That reads the OS keychain and
 * the hub's raw secret store directly, so it cannot live in this package; the
 * host runs it here, once the workspace is resolvable, before anything below
 * depends on a credential's real secret being where the hub now expects it
 * (`rerankCatalogProviders`, next, needs a provider's credential row to carry
 * usable material, not a leftover keychain pointer).
 *
 * `afterSkillAssets` is the one step this cannot do itself: reordering the
 * catalog's offerings by what each provider's plugin can actually serve is
 * product knowledge the client applies over hub catalog routes, not
 * something this package generates or judges.
 */
export async function install(
  transport: Transport,
  sidecar: SidecarCapability,
  hooks: {
    afterEnsureWorkspace?: (workspace: Workspace) => Promise<void>;
    afterSkillAssets?: () => Promise<void>;
  } = {},
): Promise<InstallState> {
  const ws = await ensureWorkspace(transport);
  await hooks.afterEnsureWorkspace?.(ws);
  await seedWorkflows(transport, ws.tenantId);

  // Authority is the platform's: the ledger's authorities become roles, and
  // the owner holds every human one.
  const roles = new Map<string, string>();
  for (const name of AUTHORITIES) {
    const role = await ensureRole(transport, ws.tenantId, name, ROLE_DESCRIPTIONS[name] ?? "");
    roles.set(name, role.id);
  }
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    // Role membership becomes a real platform grant `@intx/authz` can answer
    // for, not a "role name equals authority name" assumption in a reader.
    // Named-signal grants ride along: a role without the ledger authority
    // never receives `workflow-run:*` / `signal:<name>` for that command.
    await ensureAuthorityGrants(transport, ws.tenantId, roles.get(name)!, name);
    await assignRole(transport, ws.tenantId, ws.principalId, roles.get(name)!);
  }

  // Every project is a tenant of its own with the same roles; a project opened
  // before roles lived there gets them here.
  const projects = await listProjectRecords(transport, ws.tenantId);
  for (const project of projects) {
    await installProjectAuthority(transport, project.id, project.policy);
  }
  await ensureSkillAssets(transport, ws.tenantId);
  // A provider connected before its listing was read for what can answer
  // may still lead with a model that cannot; its offerings are put in order.
  await hooks.afterSkillAssets?.();

  // Model bindings are the catalog rows written when a provider connects, so
  // there is nothing to rebind here; re-running after a credential change is
  // what lets the lifecycle deploy once an offering exists to bind against.
  // Each project has its own deployment; the workspace asset is the one
  // installState reports.
  void deployLifecycle(
    transport,
    sidecar,
    ws.tenantId,
    projects.map((project) => project.id),
  );
  return installState(transport);
}

// The hub answers a deploy only after its probe sidecar has evaluated the
// source, which takes as long as spawning a process. Install returns at once
// and installState() reports "deploying" until the hub has answered.
let deploying: Promise<void> | null = null;
export function deployLifecycle(
  transport: Transport,
  sidecar: SidecarCapability,
  tenantId: string,
  projectIds: readonly string[] = [],
): Promise<void> {
  if (deploying) return deploying;
  lastDeployment = { status: "deploying", detail: "The hub is probing the lifecycle source." };
  deploying = ensureLifecycleDeployment(transport, sidecar, tenantId)
    .then(async (deployed) => {
      lastDeployment =
        deployed.status === "no_offering"
          ? { status: "no_offering", detail: "Connect a provider to deploy the lifecycle." }
          : deployed.status === "no_host"
            ? { status: "no_host", detail: "The host is not serving, so no sidecar can dial in." }
            : { status: deployed.status, detail: `${deployed.deploymentId} is ${deployed.deploymentStatus}.` };
      for (const projectId of projectIds) {
        await ensureLifecycleDeployment(transport, sidecar, tenantId, projectId);
      }
    })
    .catch((cause: unknown) => {
      lastDeployment = { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
    })
    .finally(() => {
      deploying = null;
    });
  return deploying;
}
