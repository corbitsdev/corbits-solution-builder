/**
 * The conversation pane's quiet event lines — the record of what happened
 * between turns, rendered as system messages among them. Every line is
 * derived from data the client already holds: the workflow's decision log,
 * the artifact ledger's versions, and the withdrawn-turn markers. Nothing is
 * synthesized; an event exists because a record does.
 */
import type { ArtifactNode } from "../../client.ts";
import type { WithdrawnMark } from "../../withdrawn-turns.ts";
import type { DecisionRecord } from "@solutions-builder/app/project-workflow/contracts";
import type { ChatMessage as UiChatMessage } from "@corbits/react-ui";
import { stageName } from "../../components.jsx";
import { INTERNAL_KINDS } from "./use-project-artifacts.ts";

export type StageEvent = {
  readonly id: string;
  /** ISO timestamp for ordering against the thread's turns; "" sorts first. */
  readonly at: string;
  readonly text: string;
  /** "boundary" gets the hairline rule the stage's first line carries. */
  readonly tone: "boundary" | "line";
};

/** The lines one stage's conversation shows, in time order after the
 *  stage's boundary. */
export function stageEvents(
  stage: number,
  decisions: readonly DecisionRecord[],
  nodes: readonly ArtifactNode[],
  marks: readonly WithdrawnMark[],
): StageEvent[] {
  const titleOf = new Map(nodes.map((node) => [node.artifactId, node.title]));
  const out: StageEvent[] = [
    {
      id: "ev:boundary",
      at: "",
      text: `Stage ${stage} · ${stageName(stage)}`,
      tone: "boundary",
    },
  ];

  for (const node of nodes) {
    if (node.stage !== stage || INTERNAL_KINDS.has(node.kind)) continue;
    out.push({
      id: `ev:node:${node.id}`,
      at: node.createdAt,
      text:
        node.kind === "source_material"
          ? `Attached · ${node.title}`
          : `${node.title} · v${node.version}`,
      tone: "line",
    });
  }

  for (const decision of decisions) {
    const at = decision.at ?? "";
    if (decision.kind === "open_review" && decision.stage === stage) {
      out.push({
        id: `ev:${decision.decisionId}`,
        at,
        text: `Review opened · ${decision.artifactId ? `${titleOf.get(decision.artifactId) ?? "the draft"} v${decision.version ?? ""}` : "the draft"}`,
        tone: "line",
      });
    } else if (decision.kind === "approve" && decision.stage === stage) {
      out.push({
        id: `ev:${decision.decisionId}`,
        at,
        text: `Approved · ${decision.artifactId ? `${titleOf.get(decision.artifactId) ?? "the stage"} v${decision.version ?? ""}` : `stage ${stage}`}`,
        tone: "line",
      });
    } else if (decision.kind === "send_back" && decision.stage === stage) {
      out.push({
        id: `ev:${decision.decisionId}`,
        at,
        text: `Sent back${decision.targetStage ? ` · to ${stageName(decision.targetStage)}` : ""}${decision.reason ? ` · “${decision.reason}”` : ""}`,
        tone: "line",
      });
    } else if (decision.kind === "send_back" && decision.targetStage === stage) {
      out.push({
        id: `ev:${decision.decisionId}:in`,
        at,
        text: `Returned · sent back from ${stageName(decision.stage)}${decision.reason ? ` · “${decision.reason}”` : ""}`,
        tone: "line",
      });
    }
  }

  for (const mark of marks) {
    if (mark.stage !== stage) continue;
    out.push({ id: `ev:mark:${mark.messageId}`, at: mark.at, text: "Turn aborted", tone: "line" });
  }

  return out;
}

/** Events as chat messages — `system` rows ChatThread renders as quiet
 *  lines, interleaved with the turns by timestamp. */
export function eventMessages(
  messages: readonly UiChatMessage[],
  events: readonly StageEvent[],
): UiChatMessage[] {
  const asMessages: UiChatMessage[] = events.map((event) => ({
    id: event.id,
    role: "system",
    parts: [{ type: "text" as const, text: event.text }],
    createdAt: event.at,
  }));
  return [...messages, ...asMessages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
