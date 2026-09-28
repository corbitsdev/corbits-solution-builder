/**
 * What this app is, for whoever installs it into a tenant: its version,
 * which the installer records on the tenant and the client reports. Nothing
 * compares a tenant against a list of workflow definitions any more -- every
 * run is a per-project workflow or a per-stage specialist deployment
 * (`ensureProjectWorkflow`, `ensureSpecialistDeployment`), not something
 * registered at install.
 */

/** Kept equal to package.json's version. */
export const APP_VERSION = "0.1.0";
