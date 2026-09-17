/**
 * The platform writes the host still makes directly on the installer's
 * behalf, because no hub route does them yet — see `apps/hub/src/hub-gaps.ts`
 * for the full UPSTREAM_GAP list this mirrors. The installer never touches a
 * database or an Interchange internal itself (`scripts/check-boundaries.ts`
 * enforces it); it calls these through whatever bridge the host hands it,
 * the same way `workbench-delegation.ts` already took a `DelegationStore`
 * rather than importing `hub-client.ts` directly.
 */

export type DefinitionRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly wireHash: string;
};

export type ChildTenant = {
  id: string;
  name: string;
  config: Record<string, unknown> | null;
  createdAt: Date;
};

export type InstallerGaps = {
  /** UPSTREAM_GAP 1: no route registers a client-generated definition row. */
  registerDefinition(tenantId: string, row: DefinitionRow): Promise<{ id: string; created: boolean }>;
  /** UPSTREAM_GAP 4: nothing lets a user adopt a pre-identity tenant. */
  adoptLegacyWorkspace(userId: string): Promise<boolean>;
  /** UPSTREAM_GAP 10: `GET /api/tenants` does not exist. */
  listChildTenants(parentId: string): Promise<ChildTenant[]>;
  /** No JSON "write tree" route on an asset. */
  writeWorkflowSourceTree(args: {
    assetId: string;
    files: Record<string, string>;
    message: string;
  }): Promise<{ commitSha: string }>;
  /** No route reads one blob off an asset's source tree. */
  readWorkflowSourceBlob(assetId: string, path: string): Promise<string | null>;
  /** UPSTREAM_GAP 11: a deployment's sidecar binding is not projected. */
  allocationBinding(anchorRunId: string): Promise<string | null>;
  /** Whether this host process can place a sidecar at all. */
  canPlaceSidecars(): boolean;
  /** This host's own sidecar-binding fingerprint, to test reachability. */
  sidecarFingerprint(): string;
};
