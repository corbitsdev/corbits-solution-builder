import { api, type ArtifactNode } from "../../client.js";
import type { ReviewState } from "@solutions-builder/app/project-workflow/contracts";
import { deliveryOpeningLine, parseDeliveryManifest } from "./delivery-opening.ts";
import { failureReason } from "./failure-message.ts";

/**
 * Stage 8's approved build archive, read straight off the workflow's own
 * recorded review (CL-8687/#496 follow-up) -- the review names the exact
 * artifact/version that was approved, never the newest node of a kind.
 */
export function approvedStage8Archive(nodes: readonly ArtifactNode[], review: ReviewState | undefined): ArtifactNode | null {
  if (!review || review.status !== "approved") return null;
  return nodes.find((node) => node.artifactId === review.artifactId && node.version === review.version) ?? null;
}

/**
 * The delivery manifest recorded alongside a build archive, resolved from
 * the archive's OWN metadata -- they are written by the same call
 * (`persistBuildEvidence`), sharing the same `variant` (`attempt-<n>`), rather than by
 * scanning for the newest `delivery_manifest` node at stage 8 (which could
 * belong to a different, unapproved attempt).
 */
export function manifestCompanionOf(nodes: readonly ArtifactNode[], archive: ArtifactNode): ArtifactNode | null {
  const candidates = nodes.filter(
    (node) => node.kind === "delivery_manifest" && node.stage === 8 && node.variant === archive.variant && node.supersededByNodeId === null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, node) => (node.createdAt > latest.createdAt ? node : latest));
}

/**
 * Stage 9's opening mail (defect 3, CL-8723 follow-up): the delivery
 * manifest the host's packaging wrote alongside the approved build
 * archive, read back and rendered into the exact text the
 * delivery-verifier's prompt promises, plus the build supervisor's own latest
 * status reply as "the checks stage 8 declared". Self-contained (reads
 * stage 8's own thread and the manifest artifact itself) so it produces the
 * identical opening whether called right after `approve()` or rebuilt on a
 * page reload. `archiveRef` is stage 8's approved review -- the workflow's
 * own record, never re-derived from the artifact graph.
 */
export type Stage9OpeningReads = Pick<typeof api, "artifactContent" | "stageAgentStatus" | "readStageThread">;

export async function composeStage9Opening(deps: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly nodes: readonly ArtifactNode[];
  readonly archiveRef: { readonly artifactId: string; readonly version: number } | null;
  readonly fallbackBuildStatusBody?: string;
  /** The hub reads, injectable so a read that fails can be exercised without a hub. */
  readonly reads?: Stage9OpeningReads;
}): Promise<string> {
  const reads = deps.reads ?? api;
  const archiveNode = deps.archiveRef
    ? (deps.nodes.find((node) => node.artifactId === deps.archiveRef!.artifactId && node.version === deps.archiveRef!.version) ?? null)
    : null;
  const manifestNode = archiveNode ? manifestCompanionOf(deps.nodes, archiveNode) : null;
  let manifestRef: Parameters<typeof deliveryOpeningLine>[0] = null;
  if (manifestNode) {
    // A manifest that cannot be read fails the opening, which is shown and
    // tried again (#570). Sent without it, the opening's marker stood for
    // good and the verifier was told there was no manifest when there was.
    let content: string;
    try {
      content = (await reads.artifactContent(deps.tenantId, manifestNode.id)).content;
    } catch (cause) {
      throw new Error(`The delivery manifest could not be read: ${failureReason(cause)}`);
    }
    const parsed = parseDeliveryManifest(content);
    if (parsed) manifestRef = { artifactId: manifestNode.artifactId, version: manifestNode.version, content: parsed };
  }
  let buildStatusBody = deps.fallbackBuildStatusBody ?? "";
  try {
    const stage8 = await reads.stageAgentStatus(deps.projectId, 8);
    if (stage8) {
      const messages = await reads.readStageThread(deps.tenantId, [stage8.address]);
      const lastAgent = [...messages].reverse().find((message) => message.author === "agent");
      if (lastAgent) buildStatusBody = lastAgent.body;
    }
  } catch (cause) {
    // In session the caller holds the status reply it has just approved; on
    // a reload nothing does, and an opening sent without it would stand for
    // good behind its marker (#570).
    if (!buildStatusBody) throw new Error(`Build and test's status could not be read: ${failureReason(cause)}`);
  }
  return deliveryOpeningLine(manifestRef, buildStatusBody || "No build status text was found.");
}
