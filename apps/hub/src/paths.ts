/** Where the host keeps its data. One place, so packaging changes one line. */
import { homedir } from "node:os";
import { join } from "node:path";

const APP = "SolutionsBuilder";

export function dataDirectory(): string {
  const override = process.env.SOLUTIONS_BUILDER_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP);
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP);
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), APP);
}

export function databaseDirectory(): string {
  return join(dataDirectory(), "pglite");
}

/**
 * The loopback port the host served on last time. Sidecars are bound to the
 * hub's address, port included, so a host that comes back on a new port
 * strands every sidecar placed by the old one. The port is remembered here
 * and taken again when it is still free.
 */
export function portFile(): string {
  return join(dataDirectory(), "port");
}
