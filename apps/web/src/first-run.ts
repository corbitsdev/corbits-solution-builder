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
  // Signed-out is known independently of `status`: a 401 on the status probe
  // itself is what reveals it (e.g. the host restarted and the session
  // cookie no longer holds), so it must not wait on `status` to be non-null.
  if (input.auth === "signed-out") return "auth";
  if (input.status === null || input.auth === "unknown") return "boot";
  if (input.installed !== "ready") return "install";
  return "ready";
}
