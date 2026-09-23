/**
 * What a request for the built interface is asking for.
 *
 * Every path that is not the host's or the hub's API is served from the
 * built interface, and a path that names no file there gets `index.html`, so
 * a client-side route reloads onto the app. That fallback must not also
 * answer for a file the interface is expected to hold: the closure manifest
 * or a compiled workflow entry that a build step never wrote. A browser
 * handed the app page for the manifest it asked for reports a JSON parse
 * error, and the missing file is never named. A path with a file extension
 * asks for a file, so when that file is absent the answer is 404 and says
 * which file; a path without one is a route, and gets the page.
 */
import { extname } from "node:path";

/** Whether `pathname` asks for a file of the built interface rather than a route of the app. */
export function asksForInterfaceFile(pathname: string): boolean {
  return extname(pathname) !== "";
}

/** The 404 body for an interface file that is not in the build. */
export function missingInterfaceFile(pathname: string, buildHint: string): string {
  return `${pathname} is not in the built interface. Run \`${buildHint}\` to produce it.`;
}
