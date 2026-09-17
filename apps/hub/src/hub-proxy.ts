/**
 * How the `/hub/*` proxy presents a request to the hub after the host's
 * outer door has already admitted the caller.
 *
 * The inbound request carries the desktop handshake (session cookie and/or
 * bearer). Those authenticate the client to this process. The hub authenticates
 * the workspace owner. Mixing both on the forwarded request would look like
 * two inner identities; drop the host's and attach the owner session instead.
 */
export function hubProxyHeaders(inbound: HeadersInit | undefined, ownerCookie: string | null): Headers {
  const headers = new Headers(inbound);
  headers.delete("cookie");
  headers.delete("authorization");
  if (ownerCookie) headers.set("cookie", ownerCookie);
  return headers;
}
