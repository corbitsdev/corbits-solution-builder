/**
 * `api.artifactGraph`'s implementation: lists the tenant's artifacts through
 * the installer, then folds them into one project's graph client-side. No
 * host route computes this — CL-8500 decision 3.
 */
import type { Transport } from "@intx/hub-client";
import { listArtifacts } from "@solutions-builder/installer";
import { foldArtifactGraph, type ArtifactGraph } from "@solutions-builder/app/artifact-graph";

export async function artifactGraphFor(
  transport: Transport,
  workspaceTenantId: string,
  projectId: string,
): Promise<ArtifactGraph> {
  const artifacts = await listArtifacts(transport, workspaceTenantId);
  return foldArtifactGraph(artifacts, projectId);
}
