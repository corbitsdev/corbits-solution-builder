/**
 * The static closure manifest `scripts/pack-closure-static.ts` writes
 * alongside its tarballs (vendored `@intx/*`, `@solutions-builder/app`,
 * tools-deck, tools-delivery, real npm deps): what `workflow-closure.ts`
 * extracts into workspace-member files for the git-push source-format
 * deploy, and what `workflow-deploy.ts`'s `ClosureSource` carries.
 */

export type ClosureManifestEntry = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly sha256: string;
};

export type ClosureManifest = {
  readonly digest: string;
  readonly packages: readonly ClosureManifestEntry[];
  /** The workspace root's `catalog` field, so a `catalog:` specifier in a
   *  closure member's manifest can be expanded without `node:fs`. */
  readonly catalog: Record<string, string>;
};
