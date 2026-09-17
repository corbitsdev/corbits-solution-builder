/**
 * Boot must create the workspace tenant before the host listens.
 *
 * The `/hub` proxy refuses unscoped `POST /api/tenants` — creating a root
 * tenant is a host-only act, via `ensureWorkspaceOnce`. If that call is
 * swallowed and the host still serves, the client install hits 403 and only
 * a restart recovers (CL-8138). Retry the in-process ensure; if it never
 * succeeds, throw so `Bun.serve` is never reached.
 *
 * Legacy-tenant adoption and credential carry are the other host-only
 * repairs: they touch the database and the keychain, so they cannot live
 * in `@solutions-builder/installer`.
 */
import { database } from "./db.js";
import { adoptLegacyWorkspace } from "./hub-migrate.js";
import {
  createWorkspace,
  hubGet,
  hubMode,
  LEGACY_TENANT_ID,
  resolveWorkspace,
} from "./hub-client.js";
import { migrateLegacyProviderCredentials } from "./credential-migration.js";

export type RetryEnsureOptions = {
  /** Tries including the first. Exhaustion throws rather than listening. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onFailure?: (cause: unknown, attempt: number) => void;
};

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 250;

/**
 * The one-time repair for a tenant created before the hub owned identity:
 * adopts it as the owner's, once, so its projects keep their tenant. A
 * no-op once the legacy tenant is gone or already adopted (or there never
 * was one), so it is safe to call on every install.
 */
export async function adoptLegacyWorkspaceOnce(): Promise<void> {
  if (await resolveWorkspace()) return;
  const me = await hubGet<{ id: string }>("/api/me");
  await adoptLegacyWorkspace(database(), me.id, LEGACY_TENANT_ID);
}

/**
 * The workspace tenant, created in-process so the `/hub` proxy never has to
 * offer `POST /api/tenants` without a parent. Idempotent: a tenant that
 * already resolves is left alone.
 */
export async function ensureWorkspaceOnce(): Promise<void> {
  if (hubMode() !== "embedded") return;
  if (await resolveWorkspace()) return;
  await createWorkspace();
}

/**
 * CL-8076: the one-time carry of a pre-upgrade keychain/file provider secret
 * into the hub's own credential row (`credential-migration.ts`). Reads the OS
 * keychain and the hub's raw secret store directly, so it cannot live in the
 * installer package. Safe on every install: an old store already emptied by a
 * prior run has nothing left to carry.
 */
export async function migrateCredentialsOnce(): Promise<void> {
  const result = await migrateLegacyProviderCredentials().catch((cause: unknown) => {
    // A per-account failure is already caught and reported inside
    // `migrateLegacyProviderCredentials`; this only catches something that
    // failed before any account could be tried (the tenant or catalog reads
    // themselves), so the rest of install still proceeds.
    console.error(
      `[credential-migration] could not carry legacy provider secrets forward: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  });
  if (result && result.failures.length > 0) {
    console.error(
      `[credential-migration] ${result.failures.length} legacy account(s) could not be migrated ` +
        `this run and will be retried on the next boot: ` +
        result.failures.map((failure) => `${failure.account} (${failure.error})`).join("; "),
    );
  }
}

export async function retryEnsureWorkspace(
  ensure: () => Promise<void>,
  options: RetryEnsureOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (attempts < 1) throw new Error("retryEnsureWorkspace requires at least one attempt.");

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ensure();
      return;
    } catch (cause) {
      last = cause;
      options.onFailure?.(cause, attempt);
      if (attempt === attempts) break;
      await sleep(delayMs);
    }
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new Error(
    `Could not ensure the workspace tenant after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${detail}. The host will not listen until the workspace exists.`,
    last instanceof Error ? { cause: last } : undefined,
  );
}
