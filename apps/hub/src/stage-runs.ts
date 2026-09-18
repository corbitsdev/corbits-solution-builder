/**
 * Stage-run helpers that stay host-side after the CL-8279 split.
 *
 * The drafting round itself — rendering the specialist prompt, waiting for
 * the workflow's agent steps, and persisting their replies as versions — now
 * lives in the workflow. `stage.draft`/`stage.reply` are client-delivered run
 * signals (`apps/web/src/run-signal.ts`), not host routes, and stage 4's own
 * output cap is a deploy-time literal baked into the workflow from the
 * tenant's designer settings (`packages/installer/src/workflow-deploy.ts`),
 * not a per-round host computation any more. What remains here is the
 * approved-inputs read (`stageInputsForSmoke`), still used by the
 * build-review host path and the smoke scripts.
 */
import type { Stage } from "@solutions-builder/app/ledger";
import { materialText, MATERIAL_KIND } from "./source-material.js";
import { DECK_KIND } from "./deck.js";
import { renderInputs } from "@solutions-builder/app/stage-prompt";
import { asc, eq, isNull, and } from "drizzle-orm";
import { database } from "./db.js";
import * as table from "./schema.js";
import { readArtifactNode } from "./projects.js";

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
