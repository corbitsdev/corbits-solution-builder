import type { SidecarCapabilityDeclaration } from "@intx/types";

/**
 * The isolation a sidecar backend gives the code it runs, as a ladder: a
 * container also isolates the process, and a VM also isolates the
 * container. A backend declares every rung it reaches as `available` and
 * every rung above it as `blocked`, so a deployment that requires
 * `isolation:vm` fails closed on the process backend instead of quietly
 * landing on a shared kernel.
 */
export const SIDECAR_ISOLATION_LEVELS = ["process", "container", "vm"] as const;

export type SidecarIsolationLevel = (typeof SIDECAR_ISOLATION_LEVELS)[number];

/** Every shipped backend runs a workbench sidecar; nothing else does. */
export const SIDECAR_RUNTIME_CAPABILITY = "runtime:sidecar";

export function sidecarCapabilityDeclarations(
  isolation: SidecarIsolationLevel,
): readonly SidecarCapabilityDeclaration[] {
  const reached = SIDECAR_ISOLATION_LEVELS.indexOf(isolation);
  return [
    { capability: SIDECAR_RUNTIME_CAPABILITY, state: "available" },
    ...SIDECAR_ISOLATION_LEVELS.map((level, index) => ({
      capability: `isolation:${level}`,
      state: index <= reached ? ("available" as const) : ("blocked" as const),
    })),
  ];
}
