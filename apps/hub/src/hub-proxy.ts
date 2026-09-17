/**
 * How the `/hub/*` proxy presents a request to the hub after the host's
 * outer door has already admitted the caller.
 *
 * The inbound request carries the desktop handshake (session cookie and/or
 * bearer). Those authenticate the client to this process. The hub authenticates
 * the workspace owner. Mixing both on the forwarded request would look like
 * two inner identities; drop the host's and attach the owner session instead.
 *
 * The proxy is not an open door onto the hub. Only the installer and workflow
 * routes the client actually drives are forwarded, plus GET /status so a
 * hosted product can ask the hub if it is up. Git tokens, the auth surface,
 * and creating a root tenant are refused even as the owner.
 */

export function hubProxyHeaders(inbound: HeadersInit | undefined, ownerCookie: string | null): Headers {
  const headers = new Headers(inbound);
  headers.delete("cookie");
  headers.delete("authorization");
  if (ownerCookie) headers.set("cookie", ownerCookie);
  return headers;
}

/**
 * Copies inbound headers without spreading a `Headers` object (that would
 * drop cookie and content-type) and attaches the hosted-hub bearer when one
 * is present.
 */
export function remoteHubHeaders(inbound: HeadersInit | undefined, token: string | null): Headers {
  const headers = new Headers(inbound);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

const TENANT = "/api/tenants/[^/]+";

const ALLOWED: { method: string; path: RegExp }[] = [
  { method: "GET", path: /^\/status$/ },
  { method: "GET", path: /^\/api\/me$/ },
  { method: "GET", path: /^\/api\/me\/principals$/ },
  { method: "GET", path: new RegExp(`^${TENANT}$`) },
  { method: "PATCH", path: new RegExp(`^${TENANT}$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/roles$`) },
  { method: "POST", path: new RegExp(`^${TENANT}/roles$`) },
  { method: "POST", path: new RegExp(`^${TENANT}/principals/[^/]+/roles/[^/]+$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/grants$`) },
  { method: "POST", path: new RegExp(`^${TENANT}/grants$`) },
  { method: "DELETE", path: new RegExp(`^${TENANT}/grants/[^/]+$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/credentials$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/catalog/providers$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/catalog/models$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/catalog/offerings$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/assets$`) },
  { method: "POST", path: new RegExp(`^${TENANT}/assets$`) },
  { method: "POST", path: new RegExp(`^${TENANT}/assets/[^/]+/tree$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/assets/[^/]+/blob$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/workflows/definitions$`) },
  { method: "POST", path: new RegExp(`^${TENANT}/workflows/definitions$`) },
  { method: "GET", path: new RegExp(`^${TENANT}/workflows/deployments$`) },
  { method: "POST", path: new RegExp(`^${TENANT}/workflows/deployments$`) },
];

function parentIdOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("parentId" in body)) return null;
  const parentId = (body as { parentId?: unknown }).parentId;
  return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

/** Whether the `/hub` proxy will forward this call. */
export function hubProxyAllowed(method: string, pathWithQuery: string, body?: unknown): boolean {
  const url = new URL(pathWithQuery, "http://hub.local");
  const path = url.pathname;
  const verb = method.toUpperCase();

  if (path === "/api/auth" || path.startsWith("/api/auth/") || path.includes("/git-tokens")) {
    return false;
  }

  if (verb === "POST" && path === "/api/tenants") return parentIdOf(body) !== null;

  if (verb === "GET" && path === "/api/tenants") {
    const parentId = url.searchParams.get("parentId");
    return parentId !== null && parentId.length > 0;
  }

  return ALLOWED.some((rule) => rule.method === verb && rule.path.test(path));
}

/** Hub session cookies stay on this process; the browser already holds the host handshake. */
export function stripHubProxyCookies(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
