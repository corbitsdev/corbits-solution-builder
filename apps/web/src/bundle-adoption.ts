/**
 * Landing an imported project where the exported one was (#652). The
 * v2 import wrote the artifacts and left the workflow at Problem discovery;
 * this builds the adoption plan the legacy import already replays
 * (`adoptionPlan`, `replayAdoption`) from the bundle instead.
 *
 * A v3 bundle carries the workflow: its stage, accepted decisions and the
 * stakeholders' votes, so the position is read off those. A v2 bundle has
 * none, so the position is derived: the furthest stage with material, every
 * earlier stage's head document taken as approved, and every stakeholder's
 * vote taken as proceed, which the notes say plainly.
 *
 * Every bundled node was written under a new artifact id, so a reference
 * points at that id, the store version written here (1 for JSON; the latest
 * when a zip wrote several), and the digest of the content as written.
 */
import { LEGACY_STAGE_DRAFT_KIND, adoptionPlan, type AdoptionPlan, type AudienceVote, type LegacyNode, type LegacyPosition, type LegacyVersion } from "@solutions-builder/app/legacy-adoption";
import { stageName } from "./components.jsx";
import type { ProjectBundle } from "./project-export.ts";

const NOT_DOCUMENTS = new Set(["source_material", "material_reading", "imported_conversation", "design_feedback", "build_evidence", "delivery_manifest", "withdrawn_turns"]);

function policyOf(policy: unknown): { audiences: { name: string }[]; audienceQuorum: number } {
  const record = typeof policy === "object" && policy !== null ? (policy as Record<string, unknown>) : {};
  const audiences = Array.isArray(record.audiences)
    ? record.audiences
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).name === "string")
        .map((entry) => ({ name: entry.name as string }))
    : [];
  return { audiences, audienceQuorum: typeof record.audienceQuorum === "number" ? record.audienceQuorum : 0 };
}

/** The furthest stage the bundle has material for: an artifact or a conversation. */
export function derivedStage(bundle: ProjectBundle): number {
  const stages = [
    ...bundle.artifacts.filter((entry) => !NOT_DOCUMENTS.has(entry.node.kind)).map((entry) => entry.node.stage),
    ...bundle.conversations.map((conversation) => conversation.stage),
  ];
  return stages.length > 0 ? Math.max(1, ...stages) : 1;
}

/** The newest unsuperseded node of each kind (and stakeholder) at a stage. */
function headsAt(bundle: ProjectBundle, stage: number): ProjectBundle["artifacts"][number]["node"][] {
  const newest = new Map<string, ProjectBundle["artifacts"][number]["node"]>();
  for (const { node } of bundle.artifacts) {
    if (node.stage !== stage || node.supersededByNodeId !== null || NOT_DOCUMENTS.has(node.kind)) continue;
    const key = `${node.kind}|${node.variant ?? ""}`;
    const held = newest.get(key);
    if (!held || node.version > held.version || (node.version === held.version && node.createdAt > held.createdAt)) newest.set(key, node);
  }
  return [...newest.values()];
}

/**
 * The position to land: from the bundle's workflow when it has one, else
 * derived from its heads. `digests` are the sha256 of each node's content
 * as written, by node id.
 */
export function bundlePosition(bundle: ProjectBundle, digests: ReadonlyMap<string, string>): { position: LegacyPosition; notes: string[] } {
  const notes: string[] = [];
  const version = (node: ProjectBundle["artifacts"][number]["node"]): LegacyVersion => ({
    versionId: node.id,
    artifactId: node.artifactId,
    contentHash: digests.get(node.id) ?? "",
  });
  const approvals: Record<number, LegacyVersion[]> = {};
  const audienceVotes: Record<string, AudienceVote> = {};
  const workflow = bundle.workflow;
  if (workflow) {
    const byRef = new Map(bundle.artifacts.map(({ node }) => [`${node.artifactId}@${String(node.version)}`, node]));
    for (const decision of workflow.decisions) {
      if (decision.kind === "send_back" && decision.targetStage !== undefined) {
        for (const approved of Object.keys(approvals).map(Number)) if (approved >= decision.targetStage) delete approvals[approved];
        if (decision.targetStage <= 5) for (const name of Object.keys(audienceVotes)) delete audienceVotes[name];
        continue;
      }
      if (decision.kind !== "approve" || decision.artifactId === undefined || decision.version === undefined) continue;
      const node = byRef.get(`${decision.artifactId}@${String(decision.version)}`);
      if (!node) {
        notes.push(`${stageName(decision.stage)}'s approval names a version the bundle does not carry; replay stops before it.`);
        break;
      }
      // Concept approval's review names every stakeholder's package, so the
      // votes can be checked against them; the approval itself names one.
      const named = decision.stage === 5 ? headsAt(bundle, 5) : [node];
      approvals[decision.stage] = named.map(version);
    }
    for (const [name, vote] of Object.entries(workflow.audienceDecisions)) audienceVotes[name] = { decision: vote.decision, note: vote.note ?? "" };
    return { position: { stage: workflow.stage, done: workflow.done, approvals, audienceVotes }, notes };
  }
  const stage = derivedStage(bundle);
  for (let at = 1; at < stage; at += 1) {
    const heads = headsAt(bundle, at);
    const wanted = LEGACY_STAGE_DRAFT_KIND[at];
    const draft = heads.filter((node) => node.kind === wanted);
    if (draft.length === 0) {
      notes.push(`${stageName(at)} has no document in the export; replay stops before it.`);
      break;
    }
    approvals[at] = heads.map(version);
  }
  if (stage > 5 && approvals[5]) {
    for (const audience of policyOf(bundle.project.policy).audiences) {
      audienceVotes[audience.name] = { decision: "proceed", note: "Taken as proceed on import: the export carried no decisions, and the project had passed Concept approval." };
    }
    notes.push("The export carried no decisions, so every stakeholder's Concept approval vote was taken as proceed.");
  }
  return { position: { stage, done: false, approvals, audienceVotes }, notes };
}

/**
 * The adoption plan for the imported project: references re-pointed at the
 * artifacts written here (`ids`, bundled node id to new artifact id), each
 * at the store version written here (`1` unless a zip wrote several) with
 * the digest of its content.
 */
export function bundleAdoptionPlan(
  bundle: ProjectBundle,
  newProjectId: string,
  ids: ReadonlyMap<string, string>,
  digests: ReadonlyMap<string, string>,
  written: ReadonlyMap<string, number> = new Map(),
): AdoptionPlan {
  const { position, notes } = bundlePosition(bundle, digests);
  const nodes: LegacyNode[] = bundle.artifacts
    .filter(({ node }) => ids.has(node.id))
    .map(({ node }) => ({
      id: node.id,
      projectId: newProjectId,
      artifactId: ids.get(node.id)!,
      version: written.get(node.id) ?? 1,
      kind: node.kind,
      stage: node.stage,
      variant: node.variant,
      mediaType: node.mediaType ?? "text/markdown",
      provenance: node.provenance,
      supersededByNodeId: node.supersededByNodeId,
    }));
  const content = new Map(bundle.artifacts.filter(({ node }) => ids.has(node.id)).map(({ node, content }) => [ids.get(node.id)!, content]));
  // The references name the new ids: rewrite the position's versions.
  const approvals: Record<number, LegacyVersion[]> = {};
  for (const [stage, versions] of Object.entries(position.approvals)) {
    approvals[Number(stage)] = versions.flatMap((v) => (ids.has(v.versionId) ? [{ ...v, artifactId: ids.get(v.versionId)! }] : []));
  }
  const plan = adoptionPlan({
    projectId: newProjectId,
    position: { ...position, approvals },
    nodes,
    policy: policyOf(bundle.project.policy),
    readContent: (artifactId) => content.get(artifactId) ?? null,
  });
  return { ...plan, notes: [...notes, ...plan.notes] };
}
