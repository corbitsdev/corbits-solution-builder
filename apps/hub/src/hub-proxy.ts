/**
 * `/hub/*` is a same-origin prefix strip onto the hub app.
 *
 * The inbound request already passed the host's outer door (desktop handshake,
 * if present). After that this is not a policy proxy: no allowlist, no
 * owner-session swap, no Set-Cookie stripping. The browser's own cookies go
 * through. Interchange authz is policy.
 */

/** Strip the `/hub` prefix so the mounted hub sees its own paths. */
export function hubMountPath(pathname: string, search = ""): string {
  return pathname.replace(/^\/hub/, "") + search;
}

/**
 * Copies inbound headers, including the browser's cookies. Drops the host
 * handshake bearer so the hub does not see a second identity; does not attach
 * an owner session.
 */
export function hubProxyHeaders(inbound: HeadersInit | undefined): Headers {
  const headers = new Headers(inbound);
  headers.delete("authorization");
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
