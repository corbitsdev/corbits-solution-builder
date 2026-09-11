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
 * The file that records the start-at-login choice.
 *
 * A file rather than a row, because the desktop host reads it before the
 * database is open — it is the first thing the Rust process needs and the last
 * thing that should require a query. Its presence is the choice; §3 requires
 * the opt-in to be explicit, so absent means off.
 */
export function startAtLoginMarker(): string {
  return join(dataDirectory(), "start-at-login");
}

/** The designer's settings: surface, design language, token limit, policy. */
export function designerSettingsFile(): string {
  return join(dataDirectory(), "designer.json");
}
