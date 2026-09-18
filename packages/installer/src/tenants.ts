/**
 * Tenant reads for a client that only has a `Transport`: apps/web and
 * anything else that talks to the hub over the vendored `/hub` passthrough,
 * not just the installer's own writes.
 *
 * `./hub.ts` already carries these two calls (`getTenant`, `listChildTenants`)
 * for the installer's own use; this module re-exports them under the surface
 * this package's other consumers reach for, so a caller outside the
 * installer's write path (apps/web's project list) has a named, typed thing
 * to import instead of hand-rolling `transport.fetch("GET", "/api/tenants/...")`
 * itself. It does not touch `./hub.ts` -- another lane owns edits there.
 */
export { getTenant, listChildTenants, type HubTenant } from "./hub.js";
