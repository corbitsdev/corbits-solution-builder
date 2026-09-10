/**
 * Where the Interchange hub lives.
 *
 * Solutions Builder talks to the hub through one function — `hubFetch` — and
 * never through an imported service object. That indirection is the whole
 * point: today the hub is mounted in this process and the call goes straight to
 * its Hono app with no socket; tomorrow the same call goes to a hosted hub over
 * HTTPS with a bearer token, and nothing above this file changes.
 *
 *   embedded  ships inside the desktop app, on the host's pglite database
 *   remote    a hosted hub, addressed by URL, authenticated per request
 *
 * `SOLUTIONS_BUILDER_HUB_URL` selects remote. Absent, the hub is embedded.
 * This mirrors the plan's cloud-migration rule (build plan §3): the endpoint,
 * transport authentication and tenancy change; the contract does not.
 */
import { hub, hubIsMounted, mountHub } from "./hub-mount.js";
import { readSecretResult, storeSecret } from "./provider-credentials.js";

export type HubMode = "embedded" | "remote";

export type HubEndpoint = {
  readonly mode: HubMode;
  /** Absent when embedded — there is no address, because there is no socket. */
  readonly url: string | null;
  readonly ready: boolean;
  readonly detail: string;
};

const REMOTE_TOKEN_ACCOUNT = "hub:remote-token";

function configuredUrl(): string | null {
  const raw = process.env.SOLUTIONS_BUILDER_HUB_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export function hubMode(): HubMode {
  return configuredUrl() ? "remote" : "embedded";
}

/** Ensures the hub is reachable, mounting the embedded one on first use. */
export async function ensureHub(): Promise<HubEndpoint> {
  const url = configuredUrl();
  if (url) {
    return {
      mode: "remote",
      url,
      // A remote hub's readiness is its own to report; this host does not
      // assume it, and `hubFetch` surfaces a failure honestly when it happens.
      ready: true,
      detail: `Hosted hub at ${url}.`,
    };
  }

  await mountHub();
  return {
    mode: "embedded",
    url: null,
    ready: hubIsMounted(),
    detail: "Interchange hub mounted in this process on the local database.",
  };
}

export async function setRemoteToken(token: string): Promise<void> {
  await storeSecret(REMOTE_TOKEN_ACCOUNT, token);
}

/**
 * One call path to the hub, whichever side of the boundary it is on.
 *
 * `path` is hub-relative (`/api/...`). Embedded requests are dispatched into
 * the mounted app directly — no port, nothing listening, nothing to intercept.
 */
export async function hubFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = configuredUrl();

  if (!url) {
    if (!hubIsMounted()) await mountHub();
    // `app.fetch` takes a real Request; the origin is a formality the hub's
    // routing ignores, and no socket is involved.
    return hub().app.fetch(new Request(`http://hub.local${path}`, init));
  }

  // A hosted hub without its token is a request that will fail on the other
  // side with no explanation here. If the keychain cannot answer, say so now.
  const read = await readSecretResult(`keychain:${REMOTE_TOKEN_ACCOUNT}`);
  if (read.status === "unavailable") {
    throw new Error(
      `The keychain could not be read for the hub token: ${read.detail}. ` +
        "Unlock it, or allow this app access, and try again.",
    );
  }
  const token = read.status === "found" ? read.secret : null;
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}
