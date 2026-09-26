/**
 * `api.artifactGraph`'s implementation: lists the project's artifacts
 * (its own tenant's, plus what an older project still has in the
 * workspace -- `project-artifacts.ts`) through the installer, then folds
 * them into one project's graph client-side. No host route computes this —
 * CL-8500 decision 3.
 */
import type { Transport } from "@intx/hub-client";
import { foldArtifactGraph, type ArtifactGraph } from "@solutions-builder/app/artifact-graph";
import { listProjectArtifacts } from "./project-artifacts.ts";

export async function artifactGraphFor(transport: Transport, projectId: string): Promise<ArtifactGraph> {
  return foldArtifactGraph(await listProjectArtifacts(transport, projectId), projectId);
}
