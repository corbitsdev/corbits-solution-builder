// The narrow port a backend implements to plug into the shared sidecar
// provisioner core. Shaped directly off what packages/docker-provisioner's
// interchange-plugin.ts actually needed from `docker`: start one compute
// unit for an allocation, stop/remove a unit, and find the units already
// running for an allocation (used both to sweep obsolete units after a
// successful start and to find candidates on a destroy with no recorded
// unit). Named for the domain — a "unit" of compute, not a container or a
// sandbox — so any backend (Docker, E2B, a VM pool) can implement it
// without the core knowing which one it is.
export type StartUnitArgs = {
  readonly allocationId: string;
  readonly sidecarId: string;
  readonly generation: number;
  readonly token: string;
  readonly hubWebSocketUrl: string;
};

export interface SidecarBackend {
  /** Starts a compute unit for this allocation, returning its external ref. */
  startUnit(args: StartUnitArgs): Promise<string>;
  /** Stops and removes a unit, treating "already gone" as success. */
  stopUnit(externalRef: string): Promise<void>;
  /** Lists the external refs of every unit still labeled for this allocation. */
  findUnitsByAllocation(allocationId: string): Promise<readonly string[]>;
}

/**
 * A backend throws this from startUnit()/stopUnit() to report a
 * classified failure — its own error code and whether it is worth
 * retrying — rather than a generic Error. The core forwards code/message/
 * retryable straight into the rejected EnsureSidecarResult/
 * DestroySidecarResult, so backend-specific error classification (e.g. a
 * rate limit vs. an authentication failure) survives through the shared
 * ensure/destroy skeleton unchanged.
 */
export class BackendOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "BackendOperationError";
    this.code = code;
    this.retryable = retryable;
  }
}
