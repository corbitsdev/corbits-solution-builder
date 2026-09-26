/**
 * The outer door in front of `/api/*`: every request past it is a client of
 * the host and holds the host's own session credential, except for the
 * paths the product declares self-authenticating (`ServeOptions.
 * selfAuthenticatingPaths`). Those are mounts that check each request
 * themselves, such as a run-scoped artifacts API a sidecar dials with its
 * own purpose-minted bearer: the sidecar holds no host credential and needs
 * none, because the mount's own resolver is the authority. The door still
 * refuses everything else, so the host is never an open proxy into the hub.
 */
import type { MiddlewareHandler } from "hono";

/** Whether `pathname` is `prefix` itself or lives under `prefix/`. A bare
 *  `startsWith` would let `/api/workflow-artifacts-evil` through. */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The request's pathname as the URL parser normalises it: dot segments are
 *  resolved, so `/api/workflow-artifacts/../tenants` is `/api/tenants` here
 *  and is judged as such. */
export function normalisedPathname(url: string): string {
  return new URL(url).pathname;
}

/** Whether a request to `url` is one the door leaves to its own mount. */
export function isSelfAuthenticatingPath(url: string, prefixes: readonly string[]): boolean {
  const pathname = normalisedPathname(url);
  return prefixes.some((prefix) => underPrefix(pathname, prefix));
}

/** A declared prefix must be an absolute path with no trailing slash, no
 *  query, and no dot segments, or it would never match, or match too much. */
export function assertSelfAuthenticatingPrefix(prefix: string): void {
  if (!prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("?") || prefix.includes("#")) {
    throw new Error(`selfAuthenticatingPaths entry ${JSON.stringify(prefix)} must be an absolute path without a trailing slash`);
  }
  if (normalisedPathname(`http://host${prefix}`) !== prefix) {
    throw new Error(`selfAuthenticatingPaths entry ${JSON.stringify(prefix)} is not a normalised path`);
  }
}

export interface SessionDoorOptions {
  /** Whether the request presents the host's own session credential. */
  authorised: (context: { req: { header: (name: string) => string | undefined } }) => boolean;
  /** Path prefixes whose mounts authenticate each request themselves. */
  selfAuthenticatingPaths: readonly string[];
  /** The body a refused request is answered with. */
  unauthorised: unknown;
}

export function sessionDoor(options: SessionDoorOptions): MiddlewareHandler {
  for (const prefix of options.selfAuthenticatingPaths) assertSelfAuthenticatingPrefix(prefix);
  return async (context, next) => {
    if (isSelfAuthenticatingPath(context.req.url, options.selfAuthenticatingPaths) || options.authorised(context)) {
      await next();
      return;
    }
    return context.json(options.unauthorised, 401);
  };
}
