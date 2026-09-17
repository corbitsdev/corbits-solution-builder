/**
 * The seam between this host and `@solutions-builder/installer`.
 *
 * The package never reaches a database, a keychain or an Interchange
 * internal; everything it needs from those crosses here as a `Transport`
 * (`hub-client.ts`'s `hubTransport()`, already authenticated as the owner —
 * minting that identity is `ensureOwner()`'s keychain-and-cookie affair, and
 * stays the host's) plus an `InstallerGaps` bridge for the platform writes
 * `hub-gaps.ts` still makes directly (`api-installer-gaps.ts` names the same
 * gaps as real routes; this bridge calls the functions behind them directly,
 * since the installer runs in this same process rather than over the wire).
 *
 * Everything that used to live in `install.ts`, `project-tenant.ts` and
 * `workbench-delegation.ts` now lives in the package; this file is what is
 * left of them in the hub — the transport, the gap bridge, `tenantId()` (the
 * workspace `hub-client.ts` already caches for every other per-request call)
 * as the scope the package's tenant-shaped functions need, and the handful
 * of call sites elsewhere in the hub that want "the current project" or "the
 * delegation store" without building those themselves.
 */
import {
  createProject as installerCreateProject,
  deploymentIsLive as installerDeploymentIsLive,
  deployLifecycle as installerDeployLifecycle,
  ensureLifecycleDeployment as installerEnsureLifecycleDeployment,
  forgetWorkspace as installerForgetWorkspace,
  install as installerInstall,
  installProjectAuthority as installerInstallProjectAuthority,
  installState as installerInstallState,
  InstallerError,
  lifecycleAssetName,
  LIFECYCLE_ASSET_NAME,
  listProjectRecords as installerListProjectRecords,
  liveDelegationStore,
  createProjectRecord as installerCreateProjectRecord,
  readDelegationRecord,
  readProject as installerReadProject,
  requireProject as installerRequireProject,
  updateProject as installerUpdateProject,
  type InstallState,
  type LifecycleDeployment,
  type ProjectPolicy,
  type ProjectRecord,
} from "@solutions-builder/installer";
import { ensureOwner, hubMode, hubTransport, resolveWorkspace, tenantId } from "./hub-client.js";
import { APP_VERSION } from "@solutions-builder/app/manifest";
import {
  adoptLegacyWorkspace,
  allocationBinding,
  listChildTenants,
  readWorkflowSourceBlob,
  registerDefinition,
  writeWorkflowSourceTree,
} from "./hub-gaps.js";
import { canPlaceSidecars, hub } from "./hub-mount.js";
import { rerankCatalogProviders } from "./catalog.js";
import { HostError } from "./errors.js";
import { newId } from "./ids.js";
import { migrateLegacyProviderCredentials } from "./credential-migration.js";

export type { ProjectPolicy, ProjectRecord, LifecycleDeployment };
export { lifecycleAssetName, LIFECYCLE_ASSET_NAME };

function gaps() {
  return {
    registerDefinition,
    adoptLegacyWorkspace,
    listChildTenants,
    writeWorkflowSourceTree,
    readWorkflowSourceBlob,
    allocationBinding,
    canPlaceSidecars,
    sidecarFingerprint: () => hub().sidecarBindingFingerprint,
  };
}

/** Rethrows the package's own error shape as the host's, same code and message. */
async function bridged<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof InstallerError) throw new HostError(cause.code, cause.message, cause.detail);
    throw cause;
  }
}

/** A hosted hub owns its tenants and definitions; installing into it is that hub's own lifecycle. */
const HOSTED: InstallState = {
  installed: true,
  appVersion: APP_VERSION,
  missing: [],
  stale: [],
  deployment: { status: "hosted", detail: "Managed by the hub." },
  detail: "Hosted hub: definitions are managed there.",
};

/** `installState()`, reading whatever the tenant already holds — never installs. */
export async function installState(): Promise<InstallState> {
  if (hubMode() !== "embedded") return HOSTED;
  return bridged(() => installerInstallState(hubTransport()));
}

/**
 * CL-8076: the one-time carry of a pre-upgrade keychain/file provider secret
 * into the hub's own credential row (`credential-migration.ts`). Reads the OS
 * keychain and the hub's raw secret store directly, so it cannot live in the
 * package; run once the workspace is resolvable, before `rerankCatalogProviders`
 * needs a provider's credential row to carry real material. Safe on every
 * install: an old store already emptied by a prior run has nothing left to
 * carry.
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

/** The full install: owner, workspace, roles, grants, definitions, skill assets, lifecycle deploy. */
export async function install(): Promise<InstallState> {
  if (hubMode() !== "embedded") return HOSTED;
  await ensureOwner();
  const transport = hubTransport();
  const result = await bridged(() =>
    installerInstall(transport, gaps(), {
      afterEnsureWorkspace: async () => {
        await migrateCredentialsOnce();
      },
      afterSkillAssets: async () => {
        await rerankCatalogProviders();
      },
    }),
  );
  // The package resolved or created the workspace tenant by the same slug
  // `hub-client.ts` looks up; forgetting its own cache and resolving again is
  // what lets the rest of the hub — everyday per-request tenant scoping, far
  // beyond installation, all of it synchronous against `hub-client.ts`'s own
  // cache — see the same tenant rather than a stale miss.
  installerForgetWorkspace();
  await resolveWorkspace();
  return result;
}

export async function deployLifecycle(): Promise<void> {
  await installerDeployLifecycle(hubTransport(), gaps(), tenantId());
}

/** The per-project (or workspace) lifecycle deployment, made current if it is not. */
export async function ensureLifecycleDeployment(
  projectId?: string,
  options: { replace?: boolean } = {},
): Promise<LifecycleDeployment> {
  return installerEnsureLifecycleDeployment(hubTransport(), gaps(), tenantId(), projectId, options);
}

/** Whether a deployment's sidecar is still placed, or on its way. */
export async function deploymentIsLive(deploymentId: string): Promise<boolean> {
  return installerDeploymentIsLive(hubTransport(), tenantId(), deploymentId);
}

/** A live project, or null. */
export async function readProject(projectId: string): Promise<ProjectRecord | null> {
  return bridged(() => installerReadProject(hubTransport(), projectId));
}

export async function requireProject(projectId: string): Promise<ProjectRecord> {
  return bridged(() => installerRequireProject(hubTransport(), projectId));
}

export async function updateProject(
  projectId: string,
  patch: Partial<Pick<ProjectRecord, "title" | "archivedAt" | "deletedAt" | "policy">>,
): Promise<ProjectRecord> {
  return bridged(() => installerUpdateProject(hubTransport(), projectId, patch));
}

/** Every live project under the workspace, newest first. */
export async function listProjectRecords(): Promise<ProjectRecord[]> {
  return bridged(() => installerListProjectRecords(hubTransport(), gaps(), tenantId()));
}

/** The ledger's authorities as roles in the project tenant, plus one per audience. Idempotent. */
export async function installProjectAuthority(projectId: string, policy: ProjectPolicy): Promise<void> {
  await bridged(() => installerInstallProjectAuthority(hubTransport(), projectId, policy));
}

/** Opens the project tenant and gives the owner every human authority in it — no delegation. */
export async function createProjectRecord(args: { title: string; policy: ProjectPolicy }): Promise<ProjectRecord> {
  return bridged(() =>
    installerCreateProjectRecord(hubTransport(), tenantId(), { ...args, slug: newId.projectSlug() }),
  );
}

/** Opens a project's tenant, authority and delegation. The ledger run around it is `projects.ts`'s own. */
export async function createProject(args: {
  title: string;
  policy: ProjectPolicy;
  delegatedCredentialIds?: string[];
}) {
  const transport = hubTransport();
  return bridged(() =>
    installerCreateProject(transport, gaps(), tenantId(), {
      title: args.title,
      slug: newId.projectSlug(),
      policy: args.policy,
      ...(args.delegatedCredentialIds !== undefined ? { delegatedCredentialIds: args.delegatedCredentialIds } : {}),
    }),
  );
}

/** Conceals a project that failed to finish opening: the caller's own cleanup, not the package's. */
export async function concealProject(projectId: string): Promise<void> {
  await bridged(() => installerUpdateProject(hubTransport(), projectId, { deletedAt: new Date() }));
}

export function delegationStore() {
  return liveDelegationStore(hubTransport(), tenantId());
}

export async function readProjectDelegation(projectId: string) {
  return bridged(() => readDelegationRecord(hubTransport(), projectId));
}
