/**
 * A cached, read-only resolution of a project's workflow deployment/run
 * ref -- shared by `client.ts`'s `api.projectWorkflowView` and
 * `project-view.ts`'s `loadProjectView`. Both need the same lookup
 * (`findProjectWorkflow`, which never deploys or triggers anything) at most
 * every few seconds per project, not once per render or per project-view
 * load, so this memoises the resolved ref for a short TTL to absorb bursts
 * without hiding a real change in who owns the workflow (there is none --
 * a project's workflow asset/deployment/run never changes once it exists).
 */
import type { Transport } from "@intx/hub-client";
import { findProjectWorkflow, type ProjectWorkflowDeployment } from "@solutions-builder/installer";

const CACHE_TTL_MS = 5_000;

const cache = new Map<string, { ref: ProjectWorkflowDeployment | null; expiresAt: number }>();
const inFlight = new Map<string, Promise<ProjectWorkflowDeployment | null>>();

export async function resolveProjectWorkflowRef(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
): Promise<ProjectWorkflowDeployment | null> {
  const cached = cache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) return cached.ref;

  const pending = inFlight.get(projectId);
  if (pending) return pending;

  const call = findProjectWorkflow(transport, workspaceTenantId, projectId).then((ref) => {
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
