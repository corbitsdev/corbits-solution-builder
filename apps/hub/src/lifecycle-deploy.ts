/**
 * The project's lifecycle deployment as the hub sees it.
 *
 * Rendering and first deploy belong to `@solutions-builder/installer` — the
 * client over `/hub`, and smokes through `scripts/host-install.ts`. The host's
 * executor cannot import that package; it looks up the same deployment through
 * `hub-client.ts`. This file does not copy `workflow-closure.ts`.
 */
import {
  assets,
  catalog,
  workflows,
  type HubDeployment,
} from "./hub-client.js";
import { canPlaceSidecars, hub } from "./hub-mount.js";

const ENDED_DEPLOYMENT_STATUSES = new Set(["releasing", "released", "failed"]);

function isLive(deployment: HubDeployment | undefined): deployment is HubDeployment {
  return deployment !== undefined && !ENDED_DEPLOYMENT_STATUSES.has(deployment.status);
}

export async function deploymentIsLive(deploymentId: string): Promise<boolean> {
  return isLive((await workflows.deployments()).find((entry) => entry.id === deploymentId));
}

function reachable(deployment: HubDeployment, sidecarFingerprint: string): boolean {
  const binding = deployment.provisionerBindingFingerprint ?? null;
  return binding === null || binding === sidecarFingerprint;
}

export const LIFECYCLE_ASSET_NAME = "solutions-builder-project-lifecycle";

export function lifecycleAssetName(projectId?: string): string {
  return projectId ? `${LIFECYCLE_ASSET_NAME}-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : LIFECYCLE_ASSET_NAME;
}

export type LifecycleDeployment =
  | { status: "no_offering" }
  | { status: "no_host" }
  | {
      status: "current" | "deployed";
      assetId: string;
      commitSha: string;
      deploymentId: string;
      deploymentStatus: string;
    };

function sidecarCapability(): { canPlaceSidecars: boolean; sidecarFingerprint: string } {
  return { canPlaceSidecars: canPlaceSidecars(), sidecarFingerprint: hub().sidecarBindingFingerprint };
}

/**
 * The live deployment the installer already placed for this project (or the
 * workspace). Does not render or write an asset tree.
 */
export async function ensureLifecycleDeployment(
  projectId?: string,
  _options: { replace?: boolean } = {},
): Promise<LifecycleDeployment> {
  const sidecar = sidecarCapability();
  if (!sidecar.canPlaceSidecars) return { status: "no_host" };
  const offerings = (await catalog.offerings()).filter((offering) => !offering.disabled);
  if (offerings.length === 0) return { status: "no_offering" };

  const name = lifecycleAssetName(projectId);
  const asset = (await assets.list("workflow")).find((entry) => entry.name === name);
  if (!asset) return { status: "no_host" };
  const latest = (await workflows.deployments()).find(
    (deployment) => deployment.definitionAssetId === asset.id && isLive(deployment) && reachable(deployment, sidecar.sidecarFingerprint),
  );
  if (!latest) return { status: "no_host" };
  return {
    status: "current",
    assetId: asset.id,
    commitSha: "",
    deploymentId: latest.id,
    deploymentStatus: latest.status,
  };
}
