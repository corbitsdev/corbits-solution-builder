/**
 * CL-8719: the credential a stage specialist's `@corbits/artifacts/sidecar-bundle`
 * resolves as its `hub` handle.
 *
 * Mirrors `provider-connect.ts`'s create-or-patch shape: one `http` provider
 * per workspace (its `apiBaseUrl` is the hub's own origin, the one every
 * specialist's sidecar can already reach), and one credential per specialist
 * asset, named after it so the deployed source's `credentialBindings` can
 * name it before the deployment (and therefore its anchor run id) exists.
 *
 * The credential's secret is a bearer the installer mints itself and never
 * hands back — it registers the SAME value with the hub's
 * `workflow_artifact_token` table (`registerWorkflowArtifactToken`) so
 * `mountWorkflowArtifacts`' resolver recognizes it, scoped to the anchor run
 * this deploy just created. A redeploy of the same asset rotates the secret
 * and re-registers it against the new anchor run.
 */
import { ApiError, type Transport } from "@intx/hub-client";
import { catalogFor, registerWorkflowArtifactToken, type HubProvider } from "./hub.js";

export const WORKFLOW_ARTIFACTS_PROVIDER_NAME = "sb-workflow-artifacts";

/** Mirrors `specialist-source.ts`'s: fixed per role (#41 step 5), one
 *  credential per role in each project's own tenant. */
export function workflowArtifactsCredentialName(roleId: string): string {
  return `workflow-artifacts:${roleId}`;
}

function mintToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/**
 * The provider's `apiBaseUrl` is the origin the sidecar's tool calls are
 * pinned to, and the hub fails closed (`no_origin`) at launch when it is
 * empty -- then retries silently, so the deployment sits `pending` with no
 * run and nothing recorded. The hub accepts an empty string, so the guard
 * lives here: refuse one before it becomes a provider row.
 */
function requireOrigin(hubOrigin: string): string {
  const origin = hubOrigin.trim();
  if (origin === "") {
    throw new Error(
      "the artifacts provider needs the hub's origin: a credential-bound specialist's sidecar dials it, and the hub refuses to launch one pinned to an empty origin",
    );
  }
  return origin;
}

/**
 * Exported for tests. Creates the workspace's provider, or repairs an
 * existing row whose `apiBaseUrl` is empty or differs from `hubOrigin`:
 * workspaces that tried artifact tools from the embedded app before the
 * client passed a real origin still hold a row created with `""`, and
 * reusing it as-is would keep every later bound deploy stuck.
 */
export async function ensureProvider(
  catalog: Pick<ReturnType<typeof catalogFor>, "providers" | "createProvider" | "patchProvider">,
  hubOrigin: string,
): Promise<HubProvider> {
  const origin = requireOrigin(hubOrigin);
  const existing = (await catalog.providers()).find((row) => row.name === WORKFLOW_ARTIFACTS_PROVIDER_NAME);
  if (existing) {
    if (existing.apiBaseUrl === origin) return existing;
    return catalog.patchProvider(existing.id, { apiBaseUrl: origin });
  }
  return catalog.createProvider({
    name: WORKFLOW_ARTIFACTS_PROVIDER_NAME,
    plugin: "http",
    apiBaseUrl: origin,
  });
}

/**
 * Ensures the provider + credential a specialist asset's `credentialBindings`
 * name exist, mints a fresh bearer, and registers it with the hub as valid
 * for `anchorRunId` — the deployment id this deploy just produced. Called
 * once per actual (re)deploy, never on the "already live" fast path: rotating
 * the secret would break an in-flight tool call against the still-live prior
 * deployment.
 */
export async function ensureWorkflowArtifactsCredential(
  transport: Transport,
  /** The tenant the specialist deploys in: the project's own (#29). The
   *  credential and the token registration land here, where its run is. */
  tenantId: string,
  hubOrigin: string,
  /** The kit role the deployment runs: what the credential is named for. */
  roleId: string,
  anchorRunId: string,
  /** The tenant holding the one `sb-workflow-artifacts` provider: the
   *  workspace. A project-owned credential resolves an inherited provider
   *  through the hub's tenant walk-up, so there is one provider row for
   *  every project rather than one per tenant. Defaults to `tenantId`. */
  providerTenantId: string = tenantId,
): Promise<void> {
  const catalog = catalogFor(transport, tenantId);
  const provider = await ensureProvider(catalogFor(transport, providerTenantId), hubOrigin);
  const token = mintToken();
  const name = workflowArtifactsCredentialName(roleId);
  try {
    await catalog.createCredential({ providerId: provider.id, name, type: "other", secret: token });
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const existing = await catalog.resolveCredential(name);
    if (!existing) throw cause;
    await catalog.patchCredential(existing.id, { secret: token, status: "active" });
  }
  await registerWorkflowArtifactToken(transport, tenantId, { token, anchorRunId });
}
