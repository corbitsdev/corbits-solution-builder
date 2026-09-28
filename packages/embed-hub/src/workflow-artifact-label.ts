/**
 * The project label on a record a workflow run writes (#41 step 5).
 *
 * A specialist runs in its project's own tenant (#29), so the project a
 * record belongs to is the run's tenant, and the mount's resolved run scope
 * is the one source of it: `publish_workspace` no longer bakes a project id
 * into its metadata, the generic artifact tools never carried one, and the
 * model never supplies one. The `sb.projectId` label the workspace reads
 * (`foldArtifactGraph` keys nodes on it) is stamped here from that scope,
 * overriding anything a writer claimed. Only a structured record (one that
 * already carries an `sb` object) is labelled: a bare document with no `sb`
 * is not a graph node, and inventing half a record for it would give the
 * fold a node with no kind or stage.
 *
 * `@corbits/artifacts`' run-scoped mount has no hook on create, so this is a
 * middleware ahead of it that resolves the same scope from the same headers
 * and rewrites the parsed body the route then reads.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { WorkflowRunResolver } from "@corbits/artifacts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `body` with `metadata.sb.projectId` set to `tenantId` when it carries an
 *  `sb` record; unchanged otherwise. Never mutates its input. */
export function labelWorkflowArtifactBody(body: unknown, tenantId: string): unknown {
  if (!isRecord(body)) return body;
  const metadata = body["metadata"];
  if (!isRecord(metadata)) return body;
  const sb = metadata["sb"];
  if (!isRecord(sb)) return body;
  return { ...body, metadata: { ...metadata, sb: { ...sb, projectId: tenantId } } };
}

/**
 * Stamps the project label on `POST` bodies before the mount's own route
 * parses them. A request the resolver cannot place is passed through
 * untouched for the mount to refuse. The rewritten body is handed to the
 * route through the request's body cache: Hono serves a second `json()` on
 * the same request from the cached `text`, so the stamped body goes back as
 * text (and as `json`, for a reader that keys on that).
 */
export function labelWorkflowArtifacts(resolveRunScope: WorkflowRunResolver): MiddlewareHandler {
  return async (c: Context, next) => {
    if (c.req.method !== "POST") return next();
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await resolveRunScope(token, address);
    if (scope === null) return next();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return next();
    }
    const stamped = labelWorkflowArtifactBody(body, scope.tenantId);
    // Hono types the cache by what each entry resolves to, but stores (and
    // chains `.then` on) the promise itself, so a promise is what goes in.
    c.req.bodyCache.text = Promise.resolve(JSON.stringify(stamped)) as unknown as string;
    c.req.bodyCache.json = Promise.resolve(stamped);
    return next();
  };
}
