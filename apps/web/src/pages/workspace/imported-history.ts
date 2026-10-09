/**
 * What an imported project's stage already said and wrote (#490).
 *
 * An import cannot recreate mail: each stage's chat became a read-only
 * `imported_conversation` artifact and each document a fresh version 1
 * (`project-import.ts`). The landed stage's specialist is deployed fresh,
 * and opened without either it answered the opening line alone, asked its
 * first question again and wrote a new version that dropped everything the
 * imported one held. Its opening carries the imported transcript and the
 * latest imported document as text, inside the record the chain already
 * hands over, with a line saying the stage continues from there, the way
 * Concept approval is handed the approved design (`design-handoff.ts`).
 * Once the artifact tools land (#394) the paste can become a read.
 */
import { api, STAGE_DRAFT_KIND } from "../../client.js";
import { IMPORTED_CONVERSATION_KIND } from "../../project-import.ts";
import { DESIGN_TEXT_CAP, designAsText } from "../../design-handoff.ts";
import { isHtmlDocument } from "./guidance.ts";
import type { ChainNode } from "./approved-chain.ts";

/** The line that opens an imported stage's history; what tells the specialist to continue, not restart. */
export const IMPORTED_LEAD =
  "This project was imported. This stage continues from the conversation and the document below: pick up where they leave off, do not start the stage over, and do not ask again what is already answered.";

export type ImportedHistoryNodes = {
  readonly conversation: ChainNode | null;
  readonly draft: ChainNode | null;
};

/**
 * The stage's imported conversation and its latest imported document. None
 * for a project that was not imported, or a stage the export never reached.
 */
export function importedHistoryNodes(nodes: readonly ChainNode[], stage: number): ImportedHistoryNodes {
  const ofStage = nodes.filter((node) => node.stage === stage && node.supersededByNodeId === null);
  const conversation = ofStage.find((node) => node.kind === IMPORTED_CONVERSATION_KIND) ?? null;
  if (!conversation) return { conversation: null, draft: null };
  // Every imported version was written as its own version 1, so the latest
  // is the one written last, never the highest version.
  const kind = STAGE_DRAFT_KIND[stage];
  const draft = ofStage
    .filter((node) => node.kind === kind)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  return { conversation, draft: draft ?? null };
}

/** The history as the specialist reads it: the lead, the transcript, and the latest document when there is one. */
export function renderImportedHistory(args: { readonly transcript: string; readonly document: string | null; readonly documentTitle: string | null }): string {
  const parts = [IMPORTED_LEAD, `--- THE CONVERSATION SO FAR (imported) ---\n\n${args.transcript || "(No conversation was recorded.)"}`];
  if (args.document) {
    parts.push(`--- THE LATEST DOCUMENT (imported${args.documentTitle ? `: ${args.documentTitle}` : ""}); THE NEXT VERSION BUILDS ON IT ---\n\n${args.document}`);
  }
  return parts.join("\n\n");
}

/**
 * The stage's imported history, read and rendered; "" for a stage with
 * none. A read that fails fails the opening, which is shown and tried
 * again (#570): opened without its history, the stage would start over.
 */
export async function importedHistory(
  tenantId: string,
  nodes: readonly ChainNode[],
  stage: number,
  read: (nodeId: string) => Promise<{ content: string }> = (nodeId) => api.artifactContent(tenantId, nodeId),
): Promise<string> {
  const { conversation, draft } = importedHistoryNodes(nodes, stage);
  if (!conversation) return "";
  const transcript = (await read(conversation.id)).content.trim();
  // A design is handed as its text, never its markup (#219), as the chain hands one.
  const content = draft ? (await read(draft.id)).content : "";
  const document = (isHtmlDocument(content) ? designAsText(content, DESIGN_TEXT_CAP) : content).trim();
  return renderImportedHistory({ transcript, document: document || null, documentTitle: draft?.title ?? null });
}
