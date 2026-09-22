/**
 * What makes this host Solutions Builder, declared in one place.
 *
 * `@corbits/embedded-host` is the generic runtime; these are the
 * strings and names a running process needs to be *this* product — the data
 * directory, the env contract the desktop shell and smokes share
 * (`SOLUTIONS_BUILDER_*`), the handshake line `lib.rs` greps stdout for, the
 * session cookie, the workspace tenant slug, and the owner account the
 * embedded hub mints on first run.
 */
import { initHost, type HostIdentity } from "@corbits/embedded-host";

export const IDENTITY: HostIdentity = {
  appDir: "SolutionsBuilder",
  displayName: "Solutions Builder",
  envPrefix: "SOLUTIONS_BUILDER",
  // Stable: the service name existing installs' keychain items live under.
  keychainService: "com.corbits.solutions-builder",
  oauthPageCopy: {
    productName: "Solutions Builder",
    siteUrl: "https://corbits.dev",
    siteLabel: "corbits.dev",
    githubUrl: "https://github.com/corbitsdev/solutions-builder-alpha",
    githubLabel: "github.com/corbitsdev/solutions-builder-alpha",
  },
  notificationSender: "solutions-builder",
  sessionCookie: "solutions_builder_session",
  handshakePrefix: "Solutions Builder launch URL: ",
  hubConfigScriptId: "sb-hub-config",
  globalTokenKey: "solutionsBuilderToken",
  // The shell's IPC schemes (the webview calls the shell over `ipc:` on macOS
  // and `http://ipc.localhost` elsewhere; meaningless to a browser, which has
  // neither, and harmless there), plus `https:` so `provider-catalog.ts`'s
  // `discoverModels` can validate a candidate API key by calling the
  // provider's own `/models` endpoint directly — the hub never calls out to
  // a third-party inference endpoint on the tenant's behalf.
  connectSrcExtra: ["ipc:", "http://ipc.localhost", "https:"],
  interfaceBuildHint: "bun run ui:build",
  ownerEmail: "owner@solutions-builder.local",
  ownerName: "You",
  workspaceSlug: "solutions-builder",
  legacyTenantId: "t_local",
};

export function initSolutionsBuilderHost(): void {
  initHost(IDENTITY);
}
