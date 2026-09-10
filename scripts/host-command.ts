import { join } from "node:path";

/**
 * How the host is run from source. `--conditions intx-src` is not optional: the
 * vendored Interchange packages publish their source under that export
 * condition and ship no `dist`, so without it the host cannot resolve the hub.
 */
export const HOST_COMMAND = [
  "bun",
  "--conditions",
  "intx-src",
  join(import.meta.dir, "..", "apps", "hub", "src", "server.ts"),
];
