/**
 * In-process install for smokes and seed scripts.
 *
 * The hub no longer imports `@solutions-builder/installer`. Scripts drive
 * that package with the host's authenticated transport, the same way the
 * client does over `/hub`.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import {
  ensureLifecycleDeployment as installerEnsureLifecycleDeployment,
  forgetWorkspace as installerForgetWorkspace,
  install as installerInstall,
  installState as installerInstallState,
  LIFECYCLE_ASSET_NAME,
  lifecycleAssetName,
  type InstallState,
  type SidecarCapability,
} from "@solutions-builder/installer";
import { rerankCatalogProviders } from "../apps/hub/src/catalog.js";
import {
  ensureOwner,
  forgetWorkspace as hubClientForgetWorkspace,
  hubMode,
  hubTransport,
  resolveWorkspace,
  tenantId,
} from "../apps/hub/src/hub-client.js";
import { canPlaceSidecars, hub } from "../apps/hub/src/hub-mount.js";
import { adoptLegacyWorkspaceOnce, migrateCredentialsOnce } from "../apps/hub/src/workspace-boot.js";

export { LIFECYCLE_ASSET_NAME, lifecycleAssetName };
export type { InstallState };

const HOSTED: InstallState = {
  installed: true,
  appVersion: APP_VERSION,
  missing: [],
  stale: [],
  deployment: { status: "hosted", detail: "Managed by the hub." },
  detail: "Hosted hub: definitions are managed there.",
};

function sidecarCapability(): SidecarCapability {
  return { canPlaceSidecars: canPlaceSidecars(), sidecarFingerprint: hub().sidecarBindingFingerprint };
}

export async function installState(): Promise<InstallState> {
  if (hubMode() !== "embedded") return HOSTED;
  return installerInstallState(hubTransport());
}

export async function install(): Promise<InstallState> {
  if (hubMode() !== "embedded") return HOSTED;
  await ensureOwner();
  await adoptLegacyWorkspaceOnce();
  const result = await installerInstall(hubTransport(), sidecarCapability(), {
    afterEnsureWorkspace: async () => {
      await migrateCredentialsOnce();
    },
    afterSkillAssets: async () => {
      await rerankCatalogProviders();
    },
  });
  installerForgetWorkspace();
  hubClientForgetWorkspace();
  await resolveWorkspace();
  return result;
}

export async function ensureLifecycleDeployment(
  projectId?: string,
  options: { replace?: boolean } = {},
) {
  return installerEnsureLifecycleDeployment(hubTransport(), sidecarCapability(), tenantId(), projectId, options);
}
