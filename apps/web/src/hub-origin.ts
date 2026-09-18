/**
 * Where the hub is, read once from the page `apps/hub/src/server.ts` served.
 *
 * Embedded, the host mounts the hub on this same origin and `hubUrl` is
 * `null`: every hub call below stays a relative, same-origin path. Remote
 * (`SOLUTIONS_BUILDER_HUB_URL`), it is that origin, and every hub call is
 * cross-origin to it directly — this file never falls back to the host as a
 * relay.
 */
type HubConfig = { hubUrl: string | null };

function readConfig(): HubConfig {
  if (typeof document === "undefined") return { hubUrl: null };
  const node = document.getElementById("sb-hub-config");
  if (!node?.textContent) return { hubUrl: null };
  try {
    const parsed = JSON.parse(node.textContent) as Partial<HubConfig>;
    return { hubUrl: typeof parsed.hubUrl === "string" ? parsed.hubUrl : null };
  } catch {
    return { hubUrl: null };
  }
}

let cached: HubConfig | undefined;
function config(): HubConfig {
  return (cached ??= readConfig());
}

/** The hub origin to prefix every hub call with. Empty string when same-origin. */
export function hubOrigin(): string {
  return config().hubUrl ?? "";
}

/** `"include"` when the hub is a different origin (remote); `"same-origin"` when it is this one (embedded). */
export function hubCredentials(): RequestCredentials {
  return hubOrigin() ? "include" : "same-origin";
}

/** `withCredentials` for `EventSource`, which has no `RequestCredentials` union. */
export function hubEventSourceCredentials(): boolean {
  return hubOrigin() !== "";
}
