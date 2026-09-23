/**
 * Installing the app into the workspace.
 *
 * The hub boots vanilla: migrate, mount, serve. Everything that makes it
 * *Solution Builder* — the owner as a hub user with a tenant, human roles
 * and grants, and project authority — is installed here, driven by a hub
 * `Transport` already authenticated as the signed-in principal. First run
 * signs up or in against the hub, then this call creates the workspace
 * tenant as that session. First run and upgrade are the same call, and it
 * is idempotent, so the host can ask again whenever a credential changes.
 *
 * There is no lifecycle workflow to seed or deploy any more: a stage
 * specialist is a per-project, per-stage deployment made lazily the first
 * time that stage is opened (`specialist-deploy.ts`'s
 * `ensureSpecialistDeployment`), not something `install` provisions ahead of
 * time.
 */
import type { Transport } from "@intx/hub-client";
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import { assignRole, createWorkspace, ensureRole, resolveWorkspace, type Workspace } from "./hub.js";
import { seedCatalog } from "./catalog-seed.js";
import { ensureOpusDefault } from "./model-default.js";
import { installProjectAuthority, listProjectRecords } from "./project-tenant.js";
import { ensureAuthorityGrants } from "./authority-grants.js";
import { ensureSkillAssets } from "./skill-assets.js";

export type InstallState = {
  readonly installed: boolean;
  readonly appVersion: string;
  readonly detail: string;
};

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
  const found = workspace ?? (await resolveWorkspace(transport));
  if (!found) {
    return { installed: false, appVersion: APP_VERSION, detail: "No workspace yet." };
  }
  workspace = found;
  return { installed: true, appVersion: APP_VERSION, detail: `Installed ${APP_VERSION}.` };
}

/**
 * The owner's tenant, resolved or created. Creates neither twice.
 *
 * A workspace from before the hub owned identity is the host's own concern:
 * `adoptLegacyWorkspace` (`packages/embedded-host/src/hub-migrate.ts`) is a one-time
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
  hooks: {
    afterEnsureWorkspace?: (workspace: Workspace) => Promise<void>;
    afterSkillAssets?: () => Promise<void>;
  } = {},
): Promise<InstallState> {
  const ws = await ensureWorkspace(transport);
  await hooks.afterEnsureWorkspace?.(ws);

  // The model catalog comes from the pinned `@intx/inference-catalog`: vendor
  // rows and model rows land here, on the workspace tenant, while a project
  // inherits them through tenant ancestry. Idempotent and adopting, so
  // upgrades re-run it without touching tenant edits.
  await seedCatalog(transport, ws.tenantId);
  // CL-8781 migration: workspaces connected before the opus-5 default still
  // lead with the legacy seed default (sonnet-5) — move them. Guarded, so
  // customized defaults and fresh installs (no offerings yet) are untouched.
  await ensureOpusDefault(transport, ws.tenantId);

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

  return installState(transport);
}
