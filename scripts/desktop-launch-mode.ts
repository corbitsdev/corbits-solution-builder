/**
 * How the desktop shell and `bun run dev` choose between a local host sidecar
 * and a remote origin.
 *
 * `SOLUTIONS_BUILDER_HUB_URL` is the same name the host uses to talk to a
 * hosted hub. On this path it means something stronger: do not boot a local
 * hub at all; the window loads that URL.
 */

export type DesktopLaunchMode =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly url: string };

export function desktopLaunchMode(env: {
  readonly SOLUTIONS_BUILDER_HUB_URL?: string | undefined;
}): DesktopLaunchMode {
  const raw = env.SOLUTIONS_BUILDER_HUB_URL?.trim();
  if (!raw) return { kind: "local" };
  return { kind: "remote", url: remoteHubUrl(raw) };
}

/** Whether this mode may spawn the host sidecar. Remote never does. */
export function shouldSpawnHost(mode: DesktopLaunchMode): boolean {
  return mode.kind === "local";
}

export function remoteHubUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("SOLUTIONS_BUILDER_HUB_URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SOLUTIONS_BUILDER_HUB_URL must be http or https.");
  }
  if (!parsed.hostname) {
    throw new Error("SOLUTIONS_BUILDER_HUB_URL must include a host.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("SOLUTIONS_BUILDER_HUB_URL must not include credentials.");
  }
  return trimmed;
}
