/**
 * Which full screen first launch shows. Auth is before install: the workspace
 * tenant is created as the signed-in session, not as a minted owner.
 */
export type HubAuthState = "unknown" | "signed-out" | "signed-in";
export type InstallProgress = "checking" | "installing" | "ready";

export type FirstRunScreen = "boot" | "auth" | "install" | "ready";

export function firstRunScreen(input: {
  status: unknown | null;
  auth: HubAuthState;
  installed: InstallProgress;
}): FirstRunScreen {
  if (input.status === null || input.auth === "unknown") return "boot";
  if (input.auth === "signed-out") return "auth";
  if (input.installed !== "ready") return "install";
  return "ready";
}
