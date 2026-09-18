// Declarations for the vendored @corbits/process-provisioner, typed loosely the
// way the other vendored dependencies are: their internals are their own tree's
// to typecheck. Only the surface packages/embed-hub uses is named.
declare module "@corbits/process-provisioner" {
  export type ProcessProvisionerRole = "deployment" | "probe";
  export type ProcessProvisionerConfig = {
    readonly runtimePath: string;
    readonly sidecarEntryPath: string;
    readonly allocationsDir: string;
    readonly stateFilePath: string;
    readonly hubWebSocketUrl: string;
  };
  export function readProcessProvisionerConfig(args: {
    readonly env: Record<string, string | undefined>;
    readonly dataDir: string;
    readonly hubWebSocketUrl: string;
  }): ProcessProvisionerConfig;
  export function createProcessSidecarProvisioner(opts: {
    readonly config: ProcessProvisionerConfig;
    readonly role: ProcessProvisionerRole;
  }): import("@intx/hub-sessions").SidecarProvisioner;
  export const PROCESS_PROVISIONER_ID: string;
}
