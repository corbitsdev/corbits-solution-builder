/**
 * Stage-run helpers that stay host-side after the CL-8279 split.
 *
 * The drafting round itself — rendering the specialist prompt, waiting for
 * the workflow's agent steps, and persisting their replies as versions — now
 * lives in the workflow: the client delivers a `stage.draft` signal (through
 * the stage routes, which are thin relays) and the loop owns prompt and
 * persist from there. What remains here is the host-owned half the workflow
 * cannot do for itself:
 *
 * - the approved-inputs read (`stageInputsForSmoke`), still used by the
 *   build-review host path and the smoke scripts;
 * - the round envelope's execution policy (`roundInference`): the output cap
 *   the specialist step's `inference` selector reads off the round. The cap
 *   comes from host-side settings the workflow cannot read, so it rides the
 *   signal; the prompt it caps is the workflow's.
 * - `PlanDocument`, the stage 6 documents-list shape the stages route
 *   validates before it relays.
 */
import type { Stage } from "@solutions-builder/app/ledger";
import { materialText, MATERIAL_KIND } from "./source-material.js";
import { DECK_KIND } from "./deck.js";
import { renderInputs } from "@solutions-builder/app/stage-prompt";
import { asc, eq, isNull, and } from "drizzle-orm";
import { database } from "./db.js";
import * as table from "./schema.js";
import { readArtifactNode } from "./projects.js";
import { designerSettings } from "./designer-settings.js";

/** A stage 6 documents-list entry: the plan it attaches and the labels it files under. */
export interface PlanDocument {
  readonly planId: string;
  readonly tags: readonly string[];
}

/** The document output cap a round carries when no designer setting overrides it. */
const DOCUMENT_OUTPUT_TOKENS = 16_000;

/**
 * The round envelope's execution policy: the output cap the specialist
 * step's `inference` selector reads off the round signal. The stage 4
 * designer's own configured cap wins when one is set; every other stage runs
 * under the host's document cap. The prompt the cap applies to is rendered
 * workflow-side — this only carries the number.
 */
export async function roundInference(stage: Stage): Promise<{ maxTokens: number }> {
  const designer = stage === 4 ? await designerSettings() : null;
  return { maxTokens: designer?.maxTokens ?? DOCUMENT_OUTPUT_TOKENS };
}

/** Latest-live human-approved inputs, oldest stage first — stage 9 reads these, not a draft. */
export async function approvedInputs(projectId: string) {
  const { db } = database();
  const nodes = await db
    .select()
    .from(table.artifactNode)
    .where(and(eq(table.artifactNode.projectId, projectId), isNull(table.artifactNode.supersededByNodeId)))
    .orderBy(asc(table.artifactNode.createdAt));
  const out: { node: (typeof nodes)[number]; content: string }[] = [];
  for (const node of nodes) {
    if (node.kind !== MATERIAL_KIND) continue;
    const { content } = await readArtifactNode(node.id);
    out.push({ node, content: await materialText(node, content) });
  }
  return out;
}

/**
 * The approved inputs rendered for a stage (plus the stage 8 deck for stage
 * 9). The build-review host path and the smoke scripts read these directly;
 * drafting rounds no longer do — the prompt is rendered workflow-side.
 */
export async function stageInputsForSmoke(
  projectId: string,
  stage: Stage,
): Promise<{ projectTitle: string; brief: string; inputs: string }> {
  const approved = await approvedInputs(projectId);
  const inputs = renderInputs(approved, stage);
  const first = approved[0]?.content ?? "";
  const projectTitle = first.split("\n")[0]?.slice(0, 120) || "Untitled project";
  let brief = inputs;
  if (stage === 9) {
    const { db } = database();
    const deckNodes = await db
      .select()
      .from(table.artifactNode)
      .where(and(eq(table.artifactNode.projectId, projectId), isNull(table.artifactNode.supersededByNodeId)))
      .orderBy(asc(table.artifactNode.createdAt));
    const decks: string[] = [];
    for (const node of deckNodes) {
      if (node.kind !== DECK_KIND) continue;
      decks.push((await readArtifactNode(node.id)).content);
    }
    if (decks.length > 0) brief = `${inputs}\n\n## Latest review deck\n\n${decks.at(-1)}`;
  }
  return { projectTitle, brief, inputs };
}
