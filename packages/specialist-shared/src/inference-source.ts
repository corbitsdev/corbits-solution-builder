/**
 * The inference pin the packed specialist imports. A deployed specialist
 * never runs this module: `scripts/specialist-pack.ts` leaves the import
 * external and the installer writes the tenant's pin beside `workflow.js`.
 */
const SOURCE: { readonly provider: string; readonly model: string } = { provider: "unpinned", model: "unpinned" };
export default SOURCE;
