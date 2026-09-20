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

export function workflowArtifactsCredentialName(assetName: string): string {
  return `workflow-artifacts:${assetName}`;
}

function mintToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

async function ensureProvider(
  catalog: ReturnType<typeof catalogFor>,
  hubOrigin: string,
): Promise<HubProvider> {
  const existing = (await catalog.providers()).find((row) => row.name === WORKFLOW_ARTIFACTS_PROVIDER_NAME);
  if (existing) return existing;
  return catalog.createProvider({
    name: WORKFLOW_ARTIFACTS_PROVIDER_NAME,
    plugin: "http",
    apiBaseUrl: hubOrigin,
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
  workspaceTenantId: string,
  hubOrigin: string,
  assetName: string,
  anchorRunId: string,
): Promise<void> {
  const catalog = catalogFor(transport, workspaceTenantId);
  const provider = await ensureProvider(catalog, hubOrigin);
  const token = mintToken();
  const name = workflowArtifactsCredentialName(assetName);
  try {
    await catalog.createCredential({ providerId: provider.id, name, type: "other", secret: token });
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const existing = await catalog.resolveCredential(name);
    if (!existing) throw cause;
    await catalog.patchCredential(existing.id, { secret: token, status: "active" });
  }
  await registerWorkflowArtifactToken(transport, workspaceTenantId, { token, anchorRunId });
}
