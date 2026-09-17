/**
 * The hub session cookie the host reuses for in-process hub calls.
 *
 * The browser signs up or in against `/hub/api/auth/*`. Those responses set
 * Better Auth's cookie; inbound `/hub` and `/api` requests carry it. The host
 * remembers the pair so `hubApi` and `localActor` run as that principal,
 * not as a minted owner.
 */

let sessionCookie: string | null = null;

/** The `name=value` pair Better Auth puts on `Set-Cookie`. */
export function sessionPairFromSetCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  const named = sessionPairFromCookieHeader(header);
  if (named) return named;
  const pair = header.split(";")[0]?.trim() ?? "";
  return pair.includes("=") ? pair : null;
}

/** Prefer `getSetCookie()` so a second Set-Cookie is not lost to `Headers.get`. */
export function sessionPairFromSetCookieHeaders(headers: Headers): string | null {
  const listed = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const header of listed) {
    const named = sessionPairFromCookieHeader(header);
    if (named) return named;
  }
  return sessionPairFromSetCookie(headers.get("set-cookie"));
}

/** The Better Auth session pair from an inbound `Cookie` header, if any. */
export function sessionPairFromCookieHeader(header: string | null | undefined): string | null {
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

export function currentSession(): string | null {
  return sessionCookie;
}

export function rememberSession(cookie: string | null): void {
  sessionCookie = cookie;
}
