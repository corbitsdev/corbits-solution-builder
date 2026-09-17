/**
 * The host as a client of the Interchange hub.
 *
 * Everything Solutions Builder needs from the platform goes through the hub's
 * own HTTP API, on the hub's own terms: a signed-in user, a tenant, a principal
 * with grants. Embedded, the request is dispatched into the mounted Hono app
 * with no socket; pointed at a hosted hub it goes over HTTPS with a token.
 * Nothing above this file can tell the difference, which is what makes
 * "ships inside the desktop app now, hosted later" a configuration change.
 *
 * The workspace owner is a real hub user. The host mints a password into the
 * keychain on first install, signs up, and signs in the way a browser would;
 * the session cookie is what every call below carries. There is no service
 * token and no direct table write here — every call goes through the hub's
 * own routes.
 *
 * `SOLUTIONS_BUILDER_HUB_URL` selects a hosted hub. Absent, the hub is embedded.
 */
import {
  ApiError,
  deliverWorkflowSignal,
  deployWorkflow,
  listWorkflowDeployments,
  listWorkflowRuns,
  readWorkflowRunEvents,
  registerWorkflowDefinition,
  triggerWorkflowRun,
  type DeliverSignalInput,
  type DeployWorkflowInput,
  type RegisterWorkflowDefinitionInput,
  type Transport,
  type WorkflowDeployment,
  type WorkflowRunEvent,
} from "@intx/hub-client";
import { hub, hubIsMounted, mountHub } from "./hub-mount.js";
import { remoteHubHeaders } from "./hub-proxy.js";
import { pushTarball } from "./tarball.js";
import { readSecretResult, secretReference, storeSecret } from "./host-secrets.js";
import { HostError } from "./errors.js";
import { SOLUTIONS_BUILDER_APP, assertMayMintGrant } from "@solutions-builder/app/grant-namespaces";

export type HubMode = "embedded" | "remote";

export type HubEndpoint = {
  readonly mode: HubMode;
  /** Absent when embedded — there is no address, because there is no socket. */
  readonly url: string | null;
  readonly ready: boolean;
  readonly detail: string;
};

const REMOTE_TOKEN_ACCOUNT = "hub:remote-token";
const OWNER_PASSWORD_ACCOUNT = "hub:owner-password";

/** The workspace owner's identity in the hub. One person, one local account. */
export const OWNER_EMAIL = "owner@solutions-builder.local";
export const OWNER_DISPLAY_NAME = "You";
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

export async function setRemoteToken(token: string): Promise<void> {
  await storeSecret(REMOTE_TOKEN_ACCOUNT, token);
}

/**
 * One raw call path to the hub, whichever side of the boundary it is on. No
 * identity is attached. The `/hub/*` proxy calls `ensureOwner()` then
 * `hubProxyHeaders` before this, so the forwarded request carries the owner
 * session rather than the desktop handshake. `hubApi` below is the
 * authenticated path the host itself uses.
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
  const read = await readSecretResult(await secretReference(REMOTE_TOKEN_ACCOUNT));
  if (read.status === "unavailable") {
    throw new Error(
      `The keychain could not be read for the hub token: ${read.detail}. ` +
        "Unlock it, or allow this app access, and try again.",
    );
  }
  const token = read.status === "found" ? read.secret : null;
  return fetch(`${url}${path}`, {
    ...init,
    headers: remoteHubHeaders(init?.headers, token),
  });
}

// --- The owner's session -------------------------------------------------

type AuthApi = {
  api: {
    signUpEmail: (args: { body: { email: string; password: string; name: string } }) => Promise<unknown>;
    signInEmail: (args: {
      body: { email: string; password: string };
      asResponse: true;
    }) => Promise<Response>;
  };
};

let sessionCookie: string | null = null;

/**
 * The owner's password lives in the keychain beside the provider keys. It is
 * never shown and never typed: it exists so the hub can have a real user
 * without the desktop app growing a login screen for a one-person workspace.
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

async function signIn(password: string): Promise<string | null> {
  const auth = hub().auth as unknown as AuthApi;
  const response = await auth.api.signInEmail({
    body: { email: OWNER_EMAIL, password },
    asResponse: true,
  });
  if (!response.ok) return null;
  const pair = response.headers.get("set-cookie")?.split(";")[0] ?? null;
  return pair && pair.includes("=") ? pair : null;
}

/**
 * The owner's session cookie, signing in if there is an owner to sign in as.
 * `null` means no owner exists yet: the workspace has not been installed.
 */
export async function ownerSession(): Promise<string | null> {
  if (hubMode() !== "embedded") return null;
  if (sessionCookie) return sessionCookie;
  if (!hubIsMounted()) await mountHub();
  const password = await ownerPassword(false);
  if (!password) return null;
  sessionCookie = await signIn(password);
  return sessionCookie;
}

/** Signs the owner up if the hub has never seen them, then in. */
export async function ensureOwner(): Promise<void> {
  if (hubMode() !== "embedded") return;
  if (!hubIsMounted()) await mountHub();
  const password = (await ownerPassword(true))!;
  sessionCookie = await signIn(password);
  if (sessionCookie) return;
  const auth = hub().auth as unknown as AuthApi;
  await auth.api.signUpEmail({
    body: { email: OWNER_EMAIL, password, name: OWNER_DISPLAY_NAME },
  });
  sessionCookie = await signIn(password);
  if (!sessionCookie) {
    throw new HostError(
      "internal_error",
      "The hub accepted the workspace owner but would not sign them in.",
    );
  }
}

// --- The authenticated API -----------------------------------------------

export class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`Hub ${status} on ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "HubApiError";
  }
}

/** A hub call as the workspace owner. Embedded: the cookie. Hosted: the token. */
export async function hubApi(path: string, init: RequestInit = {}): Promise<Response> {
  const cookie = await ownerSession();
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await hubFetch(path, { ...init, headers });
  // A session that expired underneath us is signed in again, once.
  if (response.status === 401 && cookie) {
    sessionCookie = null;
    const fresh = await ownerSession();
    if (fresh) {
      headers.set("cookie", fresh);
      return hubFetch(path, { ...init, headers });
    }
  }
  return response;
}

// --- The workflow client's transport --------------------------------------

/** Re-exported so callers of `workflows`/`deploymentRuns` can catch it. */
export { ApiError };

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
 * selecting a `Transport`. Exported so `scripts/host-install.ts` can hand the
 * same authenticated transport to `@solutions-builder/installer`, which
 * cannot reach `hubApi`/`hubMode` itself — everything in this file is
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

export async function hubGet<T>(path: string): Promise<T> {
  return body<T>(await hubApi(path), path);
}

export async function hubPost<T>(path: string, payload: unknown): Promise<T> {
  return body<T>(await hubApi(path, { method: "POST", body: JSON.stringify(payload) }), path);
}

export async function hubPut<T>(path: string, payload: unknown = {}): Promise<T> {
  return body<T>(await hubApi(path, { method: "PUT", body: JSON.stringify(payload) }), path);
}

export async function hubPatch<T>(path: string, payload: unknown): Promise<T> {
  return body<T>(await hubApi(path, { method: "PATCH", body: JSON.stringify(payload) }), path);
}

export async function hubDelete(path: string): Promise<void> {
  const response = await hubApi(path, { method: "DELETE" });
  if (response.status === 404) return;
  await body<unknown>(response, path);
}

type Page<T> = { data: T[]; nextCursor: string | null };

/** Every page of a cursor-paginated list. */
export async function hubList<T>(path: string): Promise<T[]> {
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

export type Workspace = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly userId: string;
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
 * Finds the workspace the owner belongs to: the tenant with this app's slug,
 * or the tenant a workspace carried before the hub owned identity. `null`
 * when the owner does not exist or holds no tenant yet.
 */
export async function resolveWorkspace(): Promise<Workspace | null> {
  if (workspace) return workspace;
  if (hubMode() === "embedded" && !(await ownerSession())) return null;
  const me = await hubApi("/api/me");
  if (!me.ok) return null;
  const user = (await me.json()) as { id: string };
  const memberships = await hubList<Membership>("/api/me/principals");
  const mine = memberships.filter((entry) => entry.kind === "user" && entry.status === "active");
  const chosen =
    mine.find((entry) => entry.tenantSlug === WORKSPACE_SLUG) ??
    mine.find((entry) => entry.tenantId === LEGACY_TENANT_ID);
  if (!chosen) return null;
  workspace = { tenantId: chosen.tenantId, principalId: chosen.principalId, userId: user.id };
  return workspace;
}

/** Creates the workspace tenant; the hub makes the owner its principal. */
export async function createWorkspace(): Promise<Workspace> {
  await hubPost("/api/tenants", { name: "Solutions Builder", slug: WORKSPACE_SLUG });
  workspace = null;
  const resolved = await resolveWorkspace();
  if (!resolved) {
    throw new HostError("internal_error", "The hub created the workspace but does not list it.");
  }
  return resolved;
}

/** Forgets the cached workspace, so the next read asks the hub again. */
export function forgetWorkspace(): void {
  workspace = null;
}

export function workspaceOrNull(): Workspace | null {
  return workspace;
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
export function tenantId(): string {
  return required().tenantId;
}

/** The owner's principal in the workspace tenant. */
export function ownerPrincipalId(): string {
  return required().principalId;
}

/** The local single-user actor every product command runs as. */
export function localActor(): { principalId: string; displayName: string } {
  return { principalId: ownerPrincipalId(), displayName: OWNER_DISPLAY_NAME };
}

export function tenantPath(rest: string): string {
  return tenantPathFor(tenantId(), rest);
}

/** A path under any tenant the owner belongs to — a project is one. */
export function tenantPathFor(scope: string, rest: string): string {
  return `/api/tenants/${scope}${rest}`;
}

// --- Tenants -----------------------------------------------------------------

export type HubTenant = {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  config?: Record<string, unknown>;
  createdAt: string;
};

/** A tenant under the workspace; the hub makes the owner its first principal. */
export async function createChildTenant(input: { name: string; slug: string }): Promise<HubTenant> {
  return hubPost<HubTenant>("/api/tenants", { ...input, parentId: tenantId() });
}

export async function getTenant(scope: string): Promise<HubTenant | null> {
  const response = await hubApi(`/api/tenants/${scope}`);
  if (response.status === 404 || response.status === 403) return null;
  return body<HubTenant>(response, `/api/tenants/${scope}`);
}

export async function patchTenant(
  scope: string,
  input: { name?: string; config?: Record<string, unknown> },
): Promise<HubTenant> {
  return hubPatch<HubTenant>(`/api/tenants/${scope}`, input);
}

export type HubPrincipal = {
  id: string;
  tenantId: string;
  kind: string;
  refId: string;
  status: string;
  roles: { id: string; name: string }[];
};

export async function listPrincipals(scope: string = tenantId()): Promise<HubPrincipal[]> {
  return hubList<HubPrincipal>(tenantPathFor(scope, "/principals"));
}

/** The owner's own principal in a tenant they belong to, or null. */
export async function myPrincipalIn(scope: string): Promise<string | null> {
  const memberships = await hubList<Membership>("/api/me/principals");
  const mine = memberships.find(
    (entry) => entry.tenantId === scope && entry.kind === "user" && entry.status === "active",
  );
  return mine?.principalId ?? null;
}

// --- Roles, grants and authority -----------------------------------------

export type HubRole = { id: string; name: string; description: string | null; isSystem: boolean };

export async function listRoles(scope: string = tenantId()): Promise<HubRole[]> {
  return hubList<HubRole>(tenantPathFor(scope, "/roles"));
}

/** The role with this name, created if the tenant does not have it. */
export async function ensureRole(
  name: string,
  description: string,
  scope: string = tenantId(),
): Promise<HubRole> {
  const existing = (await listRoles(scope)).find((role) => role.name === name);
  if (existing) return existing;
  return hubPost<HubRole>(tenantPathFor(scope, "/roles"), { name, description });
}

/** Gives a principal a role. Already holding it is not an error. */
export async function assignRole(
  principalId: string,
  roleId: string,
  scope: string = tenantId(),
): Promise<void> {
  const response = await hubApi(
    tenantPathFor(scope, `/principals/${principalId}/roles/${roleId}`),
    { method: "POST" },
  );
  if (response.ok || response.status === 409) return;
  await body<unknown>(response, `POST roles/${roleId}`);
}

export type HubGrant = {
  id: string;
  roleId: string | null;
  principalId: string | null;
  resource: string;
  action: string;
  effect: "allow" | "deny" | "ask";
  origin: string;
};

export async function listGrants(scope: string = tenantId()): Promise<HubGrant[]> {
  return hubList<HubGrant>(tenantPathFor(scope, "/grants"));
}

/** A grant on a role, created once. */
export async function ensureRoleGrant(input: {
  roleId: string;
  resource: string;
  action: string;
  effect: HubGrant["effect"];
  origin: "system" | "role";
}, scope?: string): Promise<HubGrant> {
  // Refused before the scope is even resolved: an out-of-namespace mint never
  // reaches the hub, installed or not.
  assertMayMintGrant(SOLUTIONS_BUILDER_APP, input.resource);
  const target = scope ?? tenantId();
  const grants = await listGrants(target);
  const existing = grants.find(
    (grant) =>
      grant.roleId === input.roleId &&
      grant.resource === input.resource &&
      grant.action === input.action &&
      grant.effect === input.effect,
  );
  if (existing) return existing;
  return hubPost<HubGrant>(tenantPathFor(target, "/grants"), input);
}

export type PrincipalGrantInput = {
  principalId: string;
  resource: string;
  action: string;
  effect: HubGrant["effect"];
  origin: "system" | "role" | "creator" | "invoker";
};

/** A grant on a principal: delegation carries a chosen credential into a project tenant on this. */
export async function createPrincipalGrant(
  input: PrincipalGrantInput,
  scope: string = tenantId(),
): Promise<HubGrant> {
  return hubPost<HubGrant>(tenantPathFor(scope, "/grants"), input);
}

/** Removes one grant by id; revocation deletes only what the delegation minted. */
export async function deleteGrant(grantId: string, scope: string = tenantId()): Promise<void> {
  await hubDelete(tenantPathFor(scope, `/grants/${grantId}`));
}

/** What the hub would decide for this principal on this resource and action. */
export async function evaluate(
  principalId: string,
  resource: string,
  action: string,
  scope: string = tenantId(),
): Promise<"allow" | "deny" | "ask"> {
  const result = await hubPost<{ effect: "allow" | "deny" | "ask" }>(
    tenantPathFor(scope, `/principals/${principalId}/evaluate`),
    { resource, action },
  );
  return result.effect;
}

// --- Workflow definitions (read side) --------------------------------------

export type HubDefinition = { id: string; name: string; createdAt: string };

export async function listDefinitions(): Promise<HubDefinition[]> {
  return hubList<HubDefinition>(tenantPath("/workflows/definitions"));
}

/**
 * The current definition for a name, or `null` if none is installed.
 * "Current" is the newest row: installing never mutates a definition, it adds
 * a version, so the newest is what a fresh session should key to.
 */
export async function definitionIdFor(name: string): Promise<string | null> {
  const rows = (await listDefinitions()).filter((row) => row.name === name);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return rows[0]?.id ?? null;
}

// --- The model catalog -----------------------------------------------------

export type HubProvider = {
  id: string;
  name: string;
  plugin: string;
  apiBaseUrl: string | null;
  metadata: Record<string, unknown> | null;
};

export type HubCredential = {
  id: string;
  providerId: string;
  name: string;
  type: string;
  status: string;
  /** Null when tenant-owned; set when a personal credential that never crosses tenants. */
  principalId: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: string;
};

export type HubModelProvider = {
  id: string;
  name: string;
  plugin: string;
  baseURL: string;
  credentialId: string | null;
  disabled: boolean;
};

export type HubModel = { id: string; canonicalName: string; displayName: string | null };

export type HubOffering = {
  id: string;
  modelId: string;
  providerId: string;
  priority: number;
  capabilities: string[];
  quirks: Record<string, unknown> | null;
  disabled: boolean;
};

export const catalog = {
  providers: () => hubList<HubProvider>(tenantPath("/providers")),
  createProvider: (input: {
    name: string;
    plugin: string;
    apiBaseUrl?: string;
    metadata?: Record<string, unknown>;
  }) => hubPost<HubProvider>(tenantPath("/providers"), input),
  patchProvider: (id: string, input: { apiBaseUrl?: string; metadata?: Record<string, unknown> }) =>
    hubPatch<HubProvider>(tenantPath(`/providers/${id}`), input),

  credentials: () => hubList<HubCredential>(tenantPath("/credentials")),
  createCredential: (input: {
    providerId: string;
    name: string;
    type: "api_key" | "oauth_token" | "other";
    secret: string;
    description?: string;
    scopes?: string[];
    metadata?: Record<string, unknown>;
  }) => hubPost<HubCredential>(tenantPath("/credentials"), input),
  patchCredential: (
    id: string,
    input: {
      secret?: string;
      status?: "active" | "expired" | "revoked" | "error";
      description?: string;
      scopes?: string[] | null;
      metadata?: Record<string, unknown>;
    },
  ) => hubPatch<HubCredential>(tenantPath(`/credentials/${id}`), input),
  deleteCredential: (id: string) => hubDelete(tenantPath(`/credentials/${id}`)),

  modelProviders: () => hubList<HubModelProvider>(tenantPath("/catalog/providers")),
  createModelProvider: (input: {
    name: string;
    plugin: string;
    baseURL: string;
    credentialId: string;
  }) => hubPost<HubModelProvider>(tenantPath("/catalog/providers"), input),
  patchModelProvider: (id: string, input: { baseURL?: string; disabled?: boolean }) =>
    hubPatch<HubModelProvider>(tenantPath(`/catalog/providers/${id}`), input),
  deleteModelProvider: (id: string) => hubDelete(tenantPath(`/catalog/providers/${id}`)),

  models: () => hubList<HubModel>(tenantPath("/catalog/models")),
  createModel: (input: { canonicalName: string; displayName?: string | null }) =>
    hubPost<HubModel>(tenantPath("/catalog/models"), input),

  offerings: () => hubList<HubOffering>(tenantPath("/catalog/offerings")),
  createOffering: (input: {
    modelId: string;
    providerId: string;
    priority?: number;
    capabilities?: string[];
    quirks?: Record<string, unknown>;
  }) => hubPost<HubOffering>(tenantPath("/catalog/offerings"), input),
  patchOffering: (
    id: string,
    input: { priority?: number; disabled?: boolean; capabilities?: string[]; quirks?: Record<string, unknown> | null },
  ) => hubPatch<HubOffering>(tenantPath(`/catalog/offerings/${id}`), input),
  deleteOffering: (id: string) => hubDelete(tenantPath(`/catalog/offerings/${id}`)),
};

// --- Assets and workflow deployments ---------------------------------------

export type HubAsset = { id: string; tenantId: string; kind: string; name: string };
/** The upstream client's own deployment shape; kept under the host's name. */
export type HubDeployment = WorkflowDeployment;
/** The upstream client's own run-event shape; kept under the host's name. */
export type HubRunEvent = WorkflowRunEvent;

export const assets = {
  // Bare arrays, not pages: these two routes do not paginate.
  list: (kind: string) => hubGet<HubAsset[]>(tenantPath(`/assets?kind=${kind}`)),
  create: (input: { kind: string; name: string; displayName?: string }) =>
    hubPost<HubAsset>(tenantPath("/assets"), input),
  /**
   * Pushes a client-packed tarball into a package-registry asset as a deploy
   * source. The hub stores the bytes verbatim and pins them by integrity, so
   * a pushed tarball resolves exactly like a registry-published one; the hub
   * adds nothing to the content. Rejects when the hub's reported integrity
   * differs from the bytes sent.
   */
  pushTarball: (assetId: string, filename: string, bytes: Uint8Array) =>
    pushTarball(
      {
        putBytes: (path, sent) => {
          // RequestInit's body wants an ArrayBuffer; a copy also freezes
          // the bytes the integrity check below compares against.
          const bytes = new Uint8Array(sent);
          return hubApi(tenantPath(path), {
            method: "PUT",
            headers: { "content-type": "application/gzip" },
            body: bytes.buffer as ArrayBuffer,
          }).then((response) => body<{ commit: string; integrity: string }>(response, path));
        },
      },
      { assetId, filename, bytes },
    ),
  /** Commits a tree of repo-relative files onto an asset's ref in one commit. */
  writeTree: (assetId: string, input: { files: Record<string, string>; message: string; ref?: string }) =>
    hubPost<{ commitSha: string }>(tenantPath(`/assets/${assetId}/tree`), input),
  /**
   * The bytes at `path` on an asset's ref (default the main branch), or null
   * when the asset, ref or path is absent. The route hands them back
   * base64-encoded inside a JSON envelope (so a Transport-only caller can
   * read them too, e.g. `@solutions-builder/installer`); decoded back to
   * bytes here.
   */
  readBlob: async (assetId: string, path: string, ref?: string): Promise<Uint8Array | null> => {
    const query = new URLSearchParams({ path, ...(ref ? { ref } : {}) });
    const response = await hubApi(tenantPath(`/assets/${assetId}/blob?${query.toString()}`));
    if (response.status === 404) return null;
    if (!response.ok) throw new HubApiError(response.status, response.url, await response.text());
    const { content } = (await response.json()) as { content: string };
    return Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
  },
};

/** Writes a workflow source tree in one commit and returns the commit sha. */
export async function writeWorkflowSourceTree(args: {
  assetId: string;
  files: Record<string, string>;
  message: string;
}): Promise<{ commitSha: string }> {
  return assets.writeTree(args.assetId, { files: args.files, message: args.message });
}

/** The bytes at `path` on the asset's main branch, decoded as text, or null when absent. */
export async function readWorkflowSourceBlob(assetId: string, path: string): Promise<string | null> {
  const bytes = await assets.readBlob(assetId, path);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export const workflows = {
  deployments: () => listWorkflowDeployments(hubTransport(), tenantId()),
  /**
   * Installs, probes, freezes and places a code-sourced workflow. The hub
   * answers only once the probe sidecar has evaluated the source, so this
   * call takes as long as spawning that process does.
   */
  deploy: (input: DeployWorkflowInput) => deployWorkflow(hubTransport(), tenantId(), input),
};

/**
 * Registers a definition row directly: for a caller (`workflow-seed.ts`) that
 * generated the wire projection itself rather than deploying through the
 * probe sidecar. Identity is keyed on (name, wireHash); an unchanged wireHash
 * under the same name is a no-op.
 */
export async function registerDefinition(
  scopeTenantId: string,
  input: RegisterWorkflowDefinitionInput,
): Promise<{ id: string; created: boolean }> {
  return registerWorkflowDefinition(hubTransport(), scopeTenantId, input);
}

/** Every tenant whose parent is `parentId`, oldest first. A bare array; this route does not paginate. */
export async function listChildTenants(parentId: string): Promise<HubTenant[]> {
  return hubGet<HubTenant[]>(`/api/tenants?parentId=${encodeURIComponent(parentId)}`);
}

// --- Sessions and conversation turns ---------------------------------------

/** Finds or creates an `agent_session` with a chosen id keyed to a definition. */
export async function ensureAgentSession(args: {
  sessionId: string;
  tenantId: string;
  definitionId: string;
  principalId: string;
}): Promise<void> {
  await hubPost(tenantPathFor(args.tenantId, "/sessions"), {
    sessionId: args.sessionId,
    definitionId: args.definitionId,
    principalId: args.principalId,
  });
}

/**
 * Writes one turn: the mail record the platform expects, and the
 * inference-turn/turn-part pair the command ledger reads back from.
 */
export async function writeConversationTurn(args: {
  sessionId: string;
  tenantId: string;
  runId: string;
  role: "human" | "specialist";
  body: string;
  fromPrincipalId: string;
  toPrincipalId: string;
  metadata: Record<string, unknown>;
  model: string;
}): Promise<string> {
  const written = await hubPost<{ id: string }>(
    tenantPathFor(args.tenantId, `/sessions/${args.sessionId}/turns`),
    {
      runId: args.runId,
      role: args.role,
      body: args.body,
      fromPrincipalId: args.fromPrincipalId,
      toPrincipalId: args.toPrincipalId,
      metadata: args.metadata,
      model: args.model,
    },
  );
  return written.id;
}

export type ConversationPart = {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  startedAt: string;
};

/** Every part on a session, oldest turn first. */
export async function listConversationTurns(sessionId: string): Promise<ConversationPart[]> {
  return hubGet<ConversationPart[]>(tenantPath(`/sessions/${sessionId}/turns`));
}

/**
 * The decrypted secret behind a `credential` row, tenant-scoped like the
 * platform's own resolution. Not an upstream gap — there is no route that
 * hands a sealed secret back out, on purpose, so this reaches the mounted
 * hub's own decrypt directly (`resolveInferenceMaterials`, behind
 * `hub().resolveCredentialSecret`) the same way a deployed workflow's
 * allocation resolves its bearer.
 */
export async function resolveCredentialSecret(credentialId: string): Promise<string> {
  return hub().resolveCredentialSecret(tenantId(), credentialId);
}

// --- Principals not yet minted by a hub route -------------------------------

export const SPECIALIST_PRINCIPAL_ID = "p_specialist";

export type PrincipalSeed = {
  id: string;
  tenantId: string;
  kind: "user" | "workflow";
  refId: string;
  status: "active";
};

export type PrincipalIo = {
  exists(id: string): Promise<boolean>;
  create(seed: PrincipalSeed): Promise<unknown>;
};

/**
 * `POST /api/tenants/:tenantId/principals` mints a principal from an invite,
 * not from a caller-chosen id, so the specialist's and a run's own actor
 * principal still go through the principal store directly. The store's
 * `createIfAbsent` derives the per-principal wrap a raw insert cannot; only
 * the exists-by-id pre-check stays a direct read, because only the id is
 * known (a real user row's refId is its auth user, not its id) and the
 * store's natural-key upsert cannot express "this exact row exists".
 */
export function livePrincipalIo(): PrincipalIo {
  return {
    exists: (id: string) => hub().principalExists(id),
    create: (seed: PrincipalSeed) => hub().principalStore.createIfAbsent(seed),
  };
}

export async function ensurePrincipal(seed: PrincipalSeed, io: PrincipalIo): Promise<void> {
  if (await io.exists(seed.id)) return;
  // A null return is the store's lost-the-race signal: another writer claimed
  // the natural key first, which still leaves a row for the identity.
  await io.create(seed);
}

/**
 * Registers the specialist's platform identity, once. A `principal` row is
 * what a signing key and a session both attach to; `kind: "workflow"` is the
 * enum's own name for "a workflow speaks as this".
 */
export async function ensureSpecialistPrincipal(
  scopeTenantId: string,
  io: PrincipalIo = livePrincipalIo(),
): Promise<void> {
  await ensurePrincipal(
    {
      id: SPECIALIST_PRINCIPAL_ID,
      tenantId: scopeTenantId,
      kind: "workflow",
      refId: "solutions-builder.specialist",
      status: "active",
    },
    io,
  );
}

/** A user principal by id. Same gap: nothing creates a principal except signup or invite. */
export async function ensureUserPrincipal(
  scopeTenantId: string,
  principalId: string,
  io: PrincipalIo = livePrincipalIo(),
): Promise<void> {
  await ensurePrincipal(
    { id: principalId, tenantId: scopeTenantId, kind: "user", refId: principalId, status: "active" },
    io,
  );
}

// --- Runs on a deployment ------------------------------------------------------

export const deploymentRuns = {
  /** Every run under the deployment: the stable top-level run and its children. */
  list: (anchorRunId: string) => listWorkflowRuns(hubTransport(), tenantId(), anchorRunId),
  events: (anchorRunId: string, runId: string) =>
    readWorkflowRunEvents(hubTransport(), tenantId(), anchorRunId, runId).then((r) => r.events),
  /** The first message fires the deployment's top-level run. */
  trigger: (anchorRunId: string, content: string) =>
    triggerWorkflowRun(hubTransport(), tenantId(), anchorRunId, { content }),
  /** Throws `ApiError` (from `@intx/hub-client`) on a non-2xx response. */
  signal: (anchorRunId: string, input: DeliverSignalInput) =>
    deliverWorkflowSignal(hubTransport(), tenantId(), anchorRunId, input),
  /**
   * A step output spilled to a blob because its JSON exceeded the inline
   * threshold. This route (`vendor/interchange/PATCHES.md`) is a local
   * addition to the hub with no upstream client op, so it stays hand-rolled.
   */
  blob: async (anchorRunId: string, runId: string, sha: string): Promise<Uint8Array | null> => {
    const response = await hubApi(tenantPath(`/workflows/${anchorRunId}/runs/${runId}/blobs/${sha}`));
    if (response.status === 404) return null;
    if (!response.ok) throw new HubApiError(response.status, response.url, await response.text());
    return new Uint8Array(await response.arrayBuffer());
  },
};
