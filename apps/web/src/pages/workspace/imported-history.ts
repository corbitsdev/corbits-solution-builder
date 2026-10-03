import { api, STAGE_DRAFT_KIND, type ArtifactNode } from "../../client.ts";
import { IMPORTED_CONVERSATION_KIND } from "../../project-import.ts";

/**
 * What an imported project's stage already said and wrote, for that stage's
 * opening. An import cannot recreate mail, so without this the fresh
 * specialist would start the stage over beside a transcript it never read.
 * Empty for any project that was not imported.
 */
export async function importedHistory(tenantId: string, nodes: readonly ArtifactNode[], stage: number): Promise<string> {
  const ofStage = nodes.filter((node) => node.stage === stage && node.supersededByNodeId === null);
  const conversation = ofStage.find((node) => node.kind === IMPORTED_CONVERSATION_KIND);
  if (!conversation) return "";
  const draftKind = STAGE_DRAFT_KIND[stage];
  const draft = ofStage.filter((node) => node.kind === draftKind).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const read = async (node: ArtifactNode | undefined) => (node ? (await api.artifactContent(tenantId, node.id).catch(() => null))?.content.trim() ?? "" : "");
  const [transcript, document] = await Promise.all([read(conversation), read(draft)]);
  const parts = [
    "This project was imported. Continue this stage from where it left off; do not start it over or ask again what is already answered.",
    transcript && `## Earlier conversation\n\n${transcript}`,
    document && `## Your latest document${draft ? ` (${draft.title})` : ""}\n\n${document}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}
