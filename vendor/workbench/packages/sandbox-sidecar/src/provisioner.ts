// Backend-agnostic ensure/destroy skeleton, extracted from
// packages/docker-provisioner/src/interchange-plugin.ts: in-flight ensure
// dedupe, request validation, generation-fencing via the state store,
// obsolete-unit sweeping, and the rejected() helper. A backend supplies
// only the SidecarBackend port (start/stop/find) and identity
// (id/apiVersion/bindingFingerprint); this module owns everything else a
// SidecarProvisioner needs to behave correctly under concurrent and
// out-of-order ensure()/destroy() calls.
import { sha256 } from "@intx/crypto";
import { getLogger } from "@intx/log";
import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";
import type { SidecarCapabilityDeclaration } from "@intx/types";

import { BackendOperationError, type SidecarBackend } from "./backend";
import type { AllocationStateStore } from "./state-store";

const log = getLogger(["sandbox-sidecar", "provisioner"]);

export type CreateSidecarProvisionerOpts = {
  readonly id: string;
  readonly apiVersion: 1;
  readonly bindingFingerprint: string;
  /**
   * Capabilities this backend declares to the hub's capability policy.
   * Empty declares nothing, which matches any deployment that states no
   * capability requirement -- the behaviour every allocation had before
   * Interchange replaced the placement model with capability selection.
   */
  readonly capabilities: readonly SidecarCapabilityDeclaration[];
  readonly backend: SidecarBackend;
  readonly store: AllocationStateStore;
};

export function createSidecarProvisioner(
  opts: CreateSidecarProvisionerOpts,
): SidecarProvisioner {
  const { backend, store } = opts;

  // Coalesces concurrent ensure() calls for the same allocation so two
  // callers racing the reconciler's ~1s retry loop cannot both pass
  // observeEnsure() before either has recorded a unit, each starting its
  // own compute unit.
  const inFlightEnsures = new Map<string, Promise<EnsureSidecarResult>>();

  async function ensureOnce(
    request: EnsureSidecarRequest,
  ): Promise<EnsureSidecarResult> {
    const validation = validateEnsureRequest(request);
    if (validation !== null) {
      return rejected("invalid_ensure_request", validation, false);
    }

    const observation = await store.observeEnsure({
      allocationId: request.allocationId,
      sidecarId: request.sidecarId,
      generation: request.generation,
    });
    if (observation.kind === "rejected") {
      return rejected(observation.code, observation.message, false);
    }
    if (observation.record.externalRef !== null) {
      await sweepObsoleteUnits(
        backend,
        request.allocationId,
        observation.record.externalRef,
      );
      return {
        kind: "accepted",
        externalRef: observation.record.externalRef,
      };
    }

    const tokenHashSha256 = await hashToken(request.token);
    let externalRef: string;
    try {
      externalRef = await backend.startUnit({
        allocationId: request.allocationId,
        sidecarId: request.sidecarId,
        generation: request.generation,
        token: request.token,
        hubWebSocketUrl: request.hubWebSocketUrl,
      });
    } catch (error) {
      return rejected(...classify(error, "start_unit_failed"));
    }

    const recorded = await store.recordUnit({
      allocationId: request.allocationId,
      generation: request.generation,
      externalRef,
      tokenHashSha256,
    });
    if (!recorded) {
      await backend.stopUnit(externalRef);
      return rejected(
        "stale_generation",
        `Generation ${String(request.generation)} was superseded while the unit was starting`,
        false,
      );
    }
    // Removes any other unit still labeled for this allocation: an older
    // generation's unit this ensure() is superseding, a duplicate left
    // behind by a concurrent ensure() that lost the race to record its
    // unit, or a unit from a prior process that crashed between starting
    // the unit and recordUnit(). All three look identical from here — "a
    // unit for this allocation that isn't the one we just recorded" — so
    // one sweep by allocation covers all of them.
    await sweepObsoleteUnits(backend, request.allocationId, externalRef);
    return { kind: "accepted", externalRef };
  }

  return {
    id: opts.id,
    apiVersion: opts.apiVersion,
    bindingFingerprint: opts.bindingFingerprint,
    capabilities: opts.capabilities,

    ensure(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
      const key = request.allocationId;
      const inFlight = inFlightEnsures.get(key);
      if (inFlight !== undefined) {
        return inFlight.then(() => ensureOnce(request));
      }
      const operation = ensureOnce(request);
      inFlightEnsures.set(key, operation);
      const clear = () => {
        if (inFlightEnsures.get(key) === operation) {
          inFlightEnsures.delete(key);
        }
      };
      void operation.then(clear, clear);
      return operation;
    },

    async destroy(
      request: DestroySidecarRequest,
    ): Promise<DestroySidecarResult> {
      const validation = validateDestroyRequest(request);
      if (validation !== null) {
        return rejected("invalid_destroy_request", validation, false);
      }

      const observation = await store.observeDestroy({
        allocationId: request.allocationId,
        sidecarId: request.sidecarId,
        generation: request.generation,
      });
      if (observation.kind === "rejected") {
        return rejected(observation.code, observation.message, false);
      }

      const externalRefs = new Set<string>();
      if (request.externalRef !== undefined) {
        externalRefs.add(request.externalRef);
      } else if (observation.record.externalRef !== null) {
        externalRefs.add(observation.record.externalRef);
      } else {
        for (const externalRef of await backend.findUnitsByAllocation(
          request.allocationId,
        )) {
          externalRefs.add(externalRef);
        }
      }

      for (const externalRef of externalRefs) {
        try {
          await backend.stopUnit(externalRef);
        } catch (error) {
          return rejected(...classify(error, "destroy_unit_failed"));
        }
      }
      return { kind: "destroyed" };
    },
  };
}

/**
 * Stops every unit labeled for this allocation other than the one just
 * confirmed current, best-effort: a sweep failure is logged to stderr
 * rather than failing the ensure() it runs alongside, since the
 * allocation itself is already correctly ensured by this point and an
 * orphaned unit is a leak, not a correctness bug.
 */
async function sweepObsoleteUnits(
  backend: SidecarBackend,
  allocationId: string,
  keepExternalRef: string,
): Promise<void> {
  const candidates = await backend.findUnitsByAllocation(allocationId);
  const obsolete = candidates.filter(
    (externalRef) => externalRef !== keepExternalRef,
  );
  for (const externalRef of obsolete) {
    try {
      await backend.stopUnit(externalRef);
    } catch (error) {
      log.error`failed to sweep obsolete unit ${externalRef} for allocation ${allocationId}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
}

async function hashToken(token: string): Promise<string> {
  const digest = await sha256(token);
  return Buffer.from(digest).toString("hex");
}

function validateEnsureRequest(request: EnsureSidecarRequest): string | null {
  if (request.allocationId === "") return "allocationId must not be empty";
  if (request.sidecarId === "") return "sidecarId must not be empty";
  if (request.token === "") return "token must not be empty";
  if (request.hubWebSocketUrl === "")
    return "hubWebSocketUrl must not be empty";
  if (!Number.isInteger(request.generation) || request.generation < 0) {
    return "generation must be a non-negative integer";
  }
  return null;
}

function validateDestroyRequest(request: DestroySidecarRequest): string | null {
  if (request.allocationId === "") return "allocationId must not be empty";
  if (request.sidecarId === "") return "sidecarId must not be empty";
  if (!Number.isInteger(request.generation) || request.generation < 0) {
    return "generation must be a non-negative integer";
  }
  return null;
}

function rejected(code: string, message: string, retryable: boolean) {
  return { kind: "rejected" as const, code, message, retryable };
}

function classify(
  error: unknown,
  defaultCode: string,
): readonly [code: string, message: string, retryable: boolean] {
  if (error instanceof BackendOperationError) {
    return [error.code, error.message, error.retryable];
  }
  return [
    defaultCode,
    error instanceof Error ? error.message : String(error),
    true,
  ];
}
