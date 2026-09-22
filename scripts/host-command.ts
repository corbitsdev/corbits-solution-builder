import { join } from "node:path";

/** How the host is run from source. */
export const HOST_COMMAND = [
  "bun",
  join(import.meta.dir, "..", "apps", "hub", "src", "server.ts"),
];
