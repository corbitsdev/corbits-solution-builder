/**
 * Local declaration of the `@corbits/artifacts` surface Builder uses.
 *
 * The package ships its types from `dist`, which is built at pack time and is
 * absent in a source checkout; its `bun` export condition points at raw `.ts`
 * that does not compile under this repo's stricter settings (notably
 * `exactOptionalPropertyTypes`). Declaring the surface we actually call keeps
 * our typecheck about our code, and keeps the adopted seam small enough to see.
 *
 * Verified against corbits-artifacts @ 8d4e156 by the Gate 2 spike.
 */
declare module "@corbits/artifacts" {
  import type { Hono } from "hono";

  /**
   * The package types this as drizzle's `PostgresJsDatabase`. Builder hands it
   * a pglite handle wrapped by `withPostgresJsResultShape`; see that module for
   * why.
   */
  export type ArtifactDb = {
    execute: <T = unknown>(query: unknown) => Promise<T[]>;
    transaction: <T>(callback: (tx: ArtifactTx) => Promise<T>) => Promise<T>;
  } & Record<string, unknown>;

  export type ArtifactTx = ArtifactDb;

  export type Identity = { kind: "user" | "agent"; principalId: string };

  export type ResolvedPrincipal = {
    tenantId: string;
    principalId: string;
    identity: Identity;
  };

  export type ArtifactRow = {
    id: string;
    tenantId: string | null;
    principalId: string | null;
    ownerPrincipalId: string | null;
    kind: string;
    title: string;
    content: string;
    source: unknown;
    version: number;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  export function runArtifactMigrations(db: ArtifactDb): Promise<void>;

  export function createArtifact(
    tx: ArtifactTx,
    args: {
      scope: ResolvedPrincipal;
      /** The human who owns this artifact; null for agents with no owning member. */
      ownerPrincipalId: string | null;
      kind: string;
      title: string;
      content: string;
      source: Record<string, unknown>;
    },
  ): Promise<ArtifactRow>;

  export function writeArtifactVersion(
    db: ArtifactDb,
    args: {
      scope: ResolvedPrincipal;
      artifactId: string;
      title?: string;
      content?: string;
    },
  ): Promise<{ artifactId: string; version: number; title: string }>;

  export function getArtifact(db: ArtifactDb, artifactId: string): Promise<ArtifactRow | null>;

  export function getArtifactVersion(
    db: ArtifactDb,
    artifactId: string,
    version: number,
  ): Promise<{ title: string; content: string; version: number } | null>;

  /**
   * Authorization moved to the mount layer upstream, so this no longer takes an
   * identity — the caller is expected to have already established scope.
   */
  export function listArtifacts(
    db: ArtifactDb,
    tenantId: string,
    filters: Record<string, unknown>,
  ): Promise<{ rows: ArtifactRow[]; nextCursor: string | null }>;

  export function setArtifactArchived(
    db: ArtifactDb,
    row: ArtifactRow,
    archive: boolean,
  ): Promise<ArtifactRow>;

  /** The host's grant middleware factory, `@intx/hub-api`'s `RequireGrant`. */
  export type RequireGrant = (resource: unknown, action: string) => unknown;

  export type ContentStore = Record<string, unknown>;
  export const InlineContentStore: ContentStore;

  export type MountArtifactsOpts = {
    db: ArtifactDb;
    contentStore: ContentStore;
    requireGrant: RequireGrant;
    decorate?: (tenantId: string, rows: readonly Record<string, unknown>[]) => Promise<void>;
    onArtifactCreated?: (tx: ArtifactTx, row: ArtifactRow, scope: ResolvedPrincipal) => Promise<void>;
    uploadPolicy?: Record<string, unknown>;
  };

  /** Mounts the module's artifact/version/upload routes onto a `Hono<TenantEnv>` app. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function mountArtifacts(app: Hono<any>, opts: MountArtifactsOpts): Hono<any>;
}
