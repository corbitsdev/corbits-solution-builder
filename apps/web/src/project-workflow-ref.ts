/**
 * A cached, read-only resolution of a project's workflow deployment/run
 * ref -- shared by `client.ts`'s `api.projectWorkflowView` and
 * `project-view.ts`'s `loadProjectView`. Both need the same lookup
 * (`findProjectWorkflow`, which never deploys or triggers anything) at most
 * every few seconds per project, not once per render or per project-view
 * load, so this memoises the resolved ref for a short TTL to absorb bursts
 * without hiding a real change in who owns the workflow for long: the ref
 * moves when a host restart revives the run on a fresh deployment, or when
 * `ensureProjectWorkflow` replaces a run on outdated code (#51), and either
 * seeds the cache with the new ref (`cacheProjectWorkflowRef`) as soon as
 * it has it.
 */
import type { Transport } from "@intx/hub-client";
import { createDecisionMemo, findProjectWorkflow, type ProjectWorkflowDeployment } from "@solutions-builder/installer";

const CACHE_TTL_MS = 5_000;

const cache = new Map<string, { ref: ProjectWorkflowDeployment | null; expiresAt: number }>();
// What every resolution so far has read of finished iterations and ended
// deployments' runs, kept for the session (#80): each poll then re-reads
// only the newest iteration of a live run, not every log of every
// deployment the project ever had.
const decisions = createDecisionMemo();
const inFlight = new Map<string, Promise<ProjectWorkflowDeployment | null>>();

export async function resolveProjectWorkflowRef(transport: Transport, projectId: string): Promise<ProjectWorkflowDeployment | null> {
  const cached = cache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.ref;

  const pending = inFlight.get(projectId);
  if (pending) return pending;

  const call = findProjectWorkflow(transport, projectId, decisions).then((ref) => {
    cache.set(projectId, { ref, expiresAt: Date.now() + CACHE_TTL_MS });
    return ref;
  });
  inFlight.set(projectId, call);
  try {
    return await call;
  } finally {
    inFlight.delete(projectId);
  }
}

/** Seeds the cache with a ref this session just deployed/reused via
 *  `ensureProjectWorkflow`, so the very next read does not race a stale
 *  cached-null entry from before the workflow existed. */
export function cacheProjectWorkflowRef(projectId: string, ref: ProjectWorkflowDeployment): void {
  cache.set(projectId, { ref, expiresAt: Date.now() + CACHE_TTL_MS });
}
