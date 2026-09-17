/**
 * The installer's own error contract.
 *
 * The host's `HostError` (`apps/hub/src/errors.ts`) carries the HTTP status
 * table and response-body shaping for the loopback API; it is used in thirty
 * hub files and stays there. The package cannot import it — `apps/` is off
 * limits from here — so failures the installer itself refuses (an unknown
 * credential id, a project whose owner never joined) carry this smaller
 * shape instead. The host's installer bridge catches `InstallerError` at the
 * boundary and rethrows a `HostError` with the same `code`, so a route that
 * used to see a `HostError` from these checks still does.
 */
export type InstallerErrorCode = "validation_failed" | "internal_error" | "conflict";

export class InstallerError extends Error {
  readonly code: InstallerErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: InstallerErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    this.detail = detail;
  }
}
