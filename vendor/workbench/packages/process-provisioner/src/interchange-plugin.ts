import {
  createAllocationStateStore,
  createSidecarProvisioner,
  sidecarCapabilityDeclarations,
  type AllocationStateStore,
} from "@corbits/sandbox-sidecar";
import type { SidecarProvisioner } from "@intx/hub-sessions";

import type { ProcessProvisionerConfig } from "./config";
import { createProcessBackend } from "./process-backend";
import {
  createBunSidecarProcessRunner,
  type SidecarProcessRunner,
} from "./process-runner";

const PROVISIONER_API_VERSION = 1 as const;

export const PROCESS_PROVISIONER_ID = "process";

/**
 * Which allocations this instance owns. Interchange adopts a probe's
 * allocation for the deployment when the two provisioners share id, api
 * version and binding fingerprint; that adopt path does not deploy the
 * workflow after the sidecar reconnects at the current pin, so the hub
 * runs a separate probe instance whose fingerprint never matches.
 */
export type ProcessProvisionerRole = "deployment" | "probe";

export type CreateProcessSidecarProvisionerOpts = {
  readonly config: ProcessProvisionerConfig;
  readonly role: ProcessProvisionerRole;
  readonly runner?: SidecarProcessRunner;
  readonly store?: AllocationStateStore;
};

/**
 * The default sidecar backend: every allocation is a child process of the
 * hub on the same host. Idempotence, generation fencing, and destroy
 * tombstones come from `@corbits/sandbox-sidecar`'s shared core, exactly
 * as they do for the docker and e2b backends — this package supplies only
 * the OS-level unit.
 *
 * The binding fingerprint pins the two facts that decide what a
 * provisioned sidecar actually is: which entry point runs, and which hub
 * it dials. A change to either is a different backend binding, so
 * allocations bound to the old one are not silently treated as current.
 */
export function createProcessSidecarProvisioner(
  opts: CreateProcessSidecarProvisionerOpts,
): SidecarProvisioner {
  const { config } = opts;
  const runner = opts.runner ?? createBunSidecarProcessRunner();
  const store = opts.store ?? createAllocationStateStore(config.stateFilePath);

  return createSidecarProvisioner({
    id: PROCESS_PROVISIONER_ID,
    apiVersion: PROVISIONER_API_VERSION,
    bindingFingerprint: `process:v1:${opts.role}:${config.sidecarEntryPath}:${config.hubWebSocketUrl}`,
    capabilities: sidecarCapabilityDeclarations("process"),
    backend: createProcessBackend(runner, config),
    store,
  });
}
