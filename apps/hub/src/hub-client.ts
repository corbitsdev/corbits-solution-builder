/**
 * The host as a client of the Interchange hub — narrowed to what the host
 * process itself still needs after the client-driven cutover (#372, #379)
 * moved every product route onto `@intx/hub-client` and
 * `packages/installer/src/hub.ts`. What remains:
 *
 *   - the readiness ping (`ensureHub`/`hubFetch`/`hubMode`/`remoteHubOrigin`),
 *     which `server.ts` and `api-host.ts` use to report hub state and mount
 *     the embedded hub on first use;
 *   - the signed-in session and workspace resolution (`currentSession`,
 *     `resolveWorkspace`, `forgetWorkspace`), which `api.ts` warms per
 *     request and `scripts/pack-registry-asset.ts` drives directly, in
 *     process, against the embedded hub with no browser involved;
 *   - `signInEmail`/`signUpEmail`/`hubTransport`/the asset registry helpers
 *     that same script uses to install and push the package-registry asset;
 *   - `mintOwnerSetCookie`, which `api-host.ts`'s `/owner/session` route uses
 *     to give an embedded, single-user desktop a real hub account without a
 *     sign-up screen: a fixed local identity, a password generated once into
 *     the keychain, and a session minted on the browser's own behalf. A
 *     remote hub is never a single-user desktop, so this refuses outside
 *     `hubMode() === "embedded"` — the browser's own `/api/auth/*` calls are
 *     the real account flow there (`apps/web/src/pages/auth.tsx`).
 *
 * `packages/installer/src/hub.ts` is the hub client for the product; nothing
 * here should grow back into that role.
 *
 * `SOLUTIONS_BUILDER_HUB_URL` selects a hosted hub. Absent, the hub is embedded.
 */
import { ApiError, type Transport } from "@intx/hub-client";
import { hub, hubIsMounted, mountHub, embeddedHubOrigin } from "./hub-mount.js";
import { HostError } from "./errors.js";
import { readSecretResult, secretReference, storeSecret } from "./host-secrets.js";

/** The Better Auth session pair from an inbound `Cookie` header, if any. */
function sessionPairFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const pair = part.trim();
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "better-auth.session_token" || name.endsWith("better-auth.session_token")) {
      return pair;
    }
  }
  return null;
}

/** The `name=value` pair Better Auth puts on `Set-Cookie`. */
function sessionPairFromSetCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  const named = sessionPairFromCookieHeader(header);
  if (named) return named;
  const pair = header.split(";")[0]?.trim() ?? "";
  return pair.includes("=") ? pair : null;
}

/** Prefer `getSetCookie()` so a second Set-Cookie is not lost to `Headers.get`. */
function sessionPairFromSetCookieHeaders(headers: Headers): string | null {
  const listed = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const header of listed) {
    const named = sessionPairFromCookieHeader(header);
    if (named) return named;
  }
  return sessionPairFromSetCookie(headers.get("set-cookie"));
}

/**
 * The hub session cookie this process reuses for its own in-process hub
 * calls — minted by `signInEmail`/`signUpEmail` (scripts and seeds only; the
 * browser talks to the mounted hub directly and carries its own cookie jar).
 */
let sessionCookie: string | null = null;

export function currentSession(): string | null {
  return sessionCookie;
}

function rememberSession(cookie: string | null): void {
  sessionCookie = cookie;
}

export type HubMode = "embedded" | "remote";

export type HubEndpoint = {
  readonly mode: HubMode;
  /** Absent when embedded — there is no address, because there is no socket. */
  readonly url: string | null;
  readonly ready: boolean;
  readonly detail: string;
};

/** Fallback display name when the signed-in profile has none. */
const FALLBACK_DISPLAY_NAME = "You";
/** The tenant this app installs into; found again by slug on every launch. */
export const WORKSPACE_SLUG = "solutions-builder";
/** The tenant id workspaces carried before the hub owned identity. */
export const LEGACY_TENANT_ID = "t_local";

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

/**
 * The host's own read of the hub, for the two things this process needs
 * to know about it itself: whether it is reachable (readiness, `GET
 * /status` — public, unauthenticated on the hub's own side, see
 * `vendor/interchange/packages/hub-api/src/app.ts`'s auth `skip`), and, for
 * scripts running against the embedded hub, the signed-in session's own
 * calls (`hubApi` below). This is not a request-path relay: the browser
 * never reaches the hub through this file. Embedded, it dispatches straight
 * into the mounted Hono app with no socket. Remote, `SOLUTIONS_BUILDER_HUB_URL`
 * is the browser's own hub origin too — this call is the host checking the
 * same public readiness the browser could check itself, nothing more; no
 * owner token is attached, no identity is swapped in.
 */
export async function hubFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = configuredUrl();

  if (!url) {
    if (!hubIsMounted()) await mountHub();
    // `app.fetch` takes a real Request. When the host is serving, the origin is
    // the loopback window so Better Auth Set-Cookie and CSRF match the browser.
    return hub().app.fetch(new Request(`${embeddedHubOrigin()}${path}`, init));
  }

  return fetch(`${url}${path}`, init);
}

/** The configured remote hub origin, or `null` when the hub is embedded — the
 *  browser's own base URL in remote mode (see `apps/web/src/hub-origin.ts`). */
export function remoteHubOrigin(): string | null {
  return configuredUrl();
}

// --- The signed-in session ------------------------------------------------

type AuthApi = {
  api: {
    signUpEmail: (args: { body: { email: string; password: string; name: string } }) => Promise<unknown>;
    signInEmail: (args: {
      body: { email: string; password: string };
      asResponse: true;
    }) => Promise<Response>;
  };
};

function captureSession(response: Response): string | null {
  const pair = sessionPairFromSetCookieHeaders(response.headers);
  if (pair) {
    rememberSession(pair);
    forgetWorkspace();
  }
  return pair;
}

/** Signs in as this email. Used by smokes and seed scripts, not the product UI. */
export async function signInEmail(email: string, password: string): Promise<boolean> {
  if (hubMode() !== "embedded") return false;
  if (!hubIsMounted()) await mountHub();
  const auth = hub().auth as unknown as AuthApi;
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  if (!response.ok) return false;
  return captureSession(response) !== null;
}

/** Creates the account and signs it in. Used by smokes and seed scripts. */
export async function signUpEmail(input: { email: string; password: string; name: string }): Promise<void> {
  if (hubMode() !== "embedded") return;
  if (!hubIsMounted()) await mountHub();
  const auth = hub().auth as unknown as AuthApi;
  await auth.api.signUpEmail({ body: input });
  if (await signInEmail(input.email, input.password)) return;
  throw new HostError("internal_error", "The hub accepted the account but would not sign them in.");
}

// --- The embedded owner's minted session -----------------------------------

/** The embedded workspace owner's identity. One person, one local account. */
const OWNER_EMAIL = "owner@solutions-builder.local";
const OWNER_PASSWORD_ACCOUNT = "hub:owner-password";

/**
 * The owner's password, held in the keychain beside the provider keys and
 * generated once. Never shown, never typed: an embedded desktop is a
 * single-user machine, so the hub can still have a real user without the
 * app growing a sign-up screen for it.
 */
async function ownerPassword(mintIfMissing: boolean): Promise<string | null> {
  const stored = await readSecretResult(await secretReference(OWNER_PASSWORD_ACCOUNT));
  if (stored.status === "found") return stored.secret;
  if (stored.status === "unavailable") {
    throw new HostError(
      "provider_unavailable",
      `The keychain could not be read for the workspace owner: ${stored.detail}. ` +
        "Unlock it, or allow this app access, and try again.",
      {},
      true,
    );
  }
  if (!mintIfMissing) return null;
  const minted = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await storeSecret(OWNER_PASSWORD_ACCOUNT, minted);
  return minted;
}

/** Every raw `Set-Cookie` header on a response, attributes included. */
function rawSetCookieHeaders(headers: Headers): string[] {
  const listed = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (listed.length > 0) return listed;
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Signs the embedded owner up if the hub has never seen them, then in, and
 * hands back the raw `Set-Cookie` headers Better Auth minted — for
 * `api-host.ts`'s `/owner/session` route to set on the browser's own
 * response, so the browser's cookie jar ends up holding the same session a
 * sign-up form would have left it with. Only ever called embedded: a remote
 * hub is not this process's to invent an identity on.
 */
export async function mintOwnerSetCookie(): Promise<string[]> {
  if (hubMode() !== "embedded") {
    throw new HostError(
      "provider_unavailable",
      "The workspace owner only mints for an embedded hub; a remote hub uses its own account flow.",
    );
  }
  if (!hubIsMounted()) await mountHub();
  const password = (await ownerPassword(true))!;
  const auth = hub().auth as unknown as AuthApi;

  let response = await auth.api.signInEmail({ body: { email: OWNER_EMAIL, password }, asResponse: true });
  if (!response.ok) {
    await auth.api.signUpEmail({ body: { email: OWNER_EMAIL, password, name: FALLBACK_DISPLAY_NAME } });
    response = await auth.api.signInEmail({ body: { email: OWNER_EMAIL, password }, asResponse: true });
  }

  const cookies = rawSetCookieHeaders(response.headers);
  if (!response.ok || cookies.length === 0) {
    throw new HostError(
      "internal_error",
      "The hub accepted the workspace owner but would not sign them in.",
    );
  }
  return cookies;
}

// --- The authenticated API -----------------------------------------------

class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`Hub ${status} on ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "HubApiError";
  }
}

/** A hub call as the signed-in principal. Embedded: the session cookie. Hosted: the token. */
async function hubApi(path: string, init: RequestInit = {}): Promise<Response> {
  const cookie = currentSession();
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await hubFetch(path, { ...init, headers });
  if (response.status === 401 && cookie) {
    rememberSession(null);
    forgetWorkspace();
  }
  return response;
}

// --- The workflow client's transport --------------------------------------

async function asTyped<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Left as null; the error below falls back to the raw status.
    }
    const err = parsed as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      err?.error?.code ?? "unknown",
      err?.error?.message ?? (text.slice(0, 300) || `HTTP ${response.status}`),
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text.length === 0 ? (undefined as T) : (JSON.parse(text) as T);
}

function jsonInit(method: string, requestBody?: unknown): RequestInit {
  const init: RequestInit = { method };
  if (requestBody !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(requestBody);
  }
  return init;
}

/**
 * The in-process half of the upstream `Transport` interface: dispatch into
 * the mounted Hono app, cookie-authenticated. `hubApi` already is this
 * dispatch when `hubMode()` is `"embedded"` — see `hubFetch` above — so this
 * is a shape adapter onto it, not a second implementation of the switch.
 */
function createEmbeddedTransport(): Transport {
  return {
    async fetch<T>(method: string, path: string, requestBody?: unknown): Promise<T> {
      return asTyped<T>(await hubApi(path, jsonInit(method, requestBody)));
    },
    subscribe(): () => void {
      throw new Error("The embedded hub has no socket to subscribe on.");
    },
  };
}

/**
 * The remote half of the upstream `Transport` interface: HTTPS to a hosted
 * hub, bearer-token authenticated. `hubApi` is this dispatch too when
 * `hubMode()` is `"remote"` — the token attach and the one-shot 401 retry
 * both live in `hubFetch`/`hubApi` already, and duplicating that logic here
 * would only risk it drifting from the embedded case.
 */
function createRemoteTransport(): Transport {
  return {
    async fetch<T>(method: string, path: string, requestBody?: unknown): Promise<T> {
      return asTyped<T>(await hubApi(path, jsonInit(method, requestBody)));
    },
    subscribe(): () => void {
      throw new Error("The remote hub transport has no live subscription support.");
    },
  };
}

/**
 * The same embedded/remote switch `hubMode()` has always driven, now
 * selecting a `Transport`. Exported so `scripts/pack-registry-asset.ts` can
 * hand the same authenticated transport to `@solutions-builder/installer`,
 * which cannot reach `hubApi`/`hubMode` itself — everything in this file is
 * `apps/hub/src`, off limits from `packages/installer/src`.
 */
export function hubTransport(): Transport {
  return hubMode() === "embedded" ? createEmbeddedTransport() : createRemoteTransport();
}

async function body<T>(response: Response, path: string): Promise<T> {
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Left as text.
  }
  if (!response.ok) throw new HubApiError(response.status, path, parsed);
  return parsed as T;
}

async function hubGet<T>(path: string): Promise<T> {
  return body<T>(await hubApi(path), path);
}

async function hubPost<T>(path: string, payload: unknown): Promise<T> {
  return body<T>(await hubApi(path, { method: "POST", body: JSON.stringify(payload) }), path);
}

type Page<T> = { data: T[]; nextCursor: string | null };

/** Every page of a cursor-paginated list. */
async function hubList<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const page: Page<T> = await hubGet<Page<T>>(
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

// --- The workspace ---------------------------------------------------------

type Workspace = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly userId: string;
  readonly displayName: string;
};

let workspace: Workspace | null = null;

type Membership = {
  principalId: string;
  tenantId: string;
  tenantSlug: string;
  kind: string;
  status: string;
};

/**
 * Finds the workspace the signed-in principal belongs to: the tenant with
 * this app's slug, or the tenant a workspace carried before the hub owned
 * identity. `null` when nobody is signed in or they hold no tenant yet.
 */
export async function resolveWorkspace(): Promise<Workspace | null> {
  if (workspace) return workspace;
  if (hubMode() === "embedded" && !currentSession()) return null;
  const me = await hubApi("/api/me");
  if (!me.ok) return null;
  const user = (await me.json()) as { id: string; name?: string | null };
  const memberships = await hubList<Membership>("/api/me/principals");
  const mine = memberships.filter((entry) => entry.kind === "user" && entry.status === "active");
  const chosen =
    mine.find((entry) => entry.tenantSlug === WORKSPACE_SLUG) ??
    mine.find((entry) => entry.tenantId === LEGACY_TENANT_ID);
  if (!chosen) return null;
  const displayName = user.name?.trim() || FALLBACK_DISPLAY_NAME;
  workspace = { tenantId: chosen.tenantId, principalId: chosen.principalId, userId: user.id, displayName };
  return workspace;
}

/** Forgets the cached workspace, so the next read asks the hub again. */
export function forgetWorkspace(): void {
  workspace = null;
}

function required(): Workspace {
  if (!workspace) {
    throw new HostError(
      "conflict",
      "The workspace is not installed yet. Install it, then try again.",
      { install: true },
    );
  }
  return workspace;
}

/** The workspace tenant. Throws until the workspace is installed. */
function tenantId(): string {
  return required().tenantId;
}

/** A path under any tenant the signed-in principal belongs to — a project is one. */
function tenantPathFor(scope: string, rest: string): string {
  return `/api/tenants/${scope}${rest}`;
}

function tenantPath(rest: string): string {
  return tenantPathFor(tenantId(), rest);
}

// --- The package-registry asset (scripts/pack-registry-asset.ts) -----------

export type HubAsset = { id: string; tenantId: string; kind: string; name: string };

export const assets = {
  // Bare arrays, not pages: this route does not paginate.
  list: (kind: string) => hubGet<HubAsset[]>(tenantPath(`/assets?kind=${kind}`)),
  create: (input: { kind: string; name: string; displayName?: string }) =>
    hubPost<HubAsset>(tenantPath("/assets"), input),
};
