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
import type { ChatMessage } from "../../stage-mail.ts";
import { stageName } from "../../components.jsx";
import { SWITCH_MARKER_PREFIX } from "./use-model-handoff.ts";

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
  // A brand-new project at stage 1 has nothing before it to bound -- its
  // only nodes are the opening statement and, if it attached a file, the
  // extracted reading beside it. The hairline rule and heading are only
  // worth showing once there's something they're separating.
  const freshProject =
    stage === 1 &&
    decisions.length === 0 &&
    marks.length === 0 &&
    nodes.every((node) => node.kind === "source_material" || node.kind === "material_reading");
  const out: StageEvent[] = freshProject
    ? []
    : [
        {
          id: "ev:boundary",
          at: "",
          text: `Stage ${stage} · ${stageName(stage)}`,
          tone: "boundary",
        },
      ];

  for (const node of nodes) {
    if (node.stage !== stage || node.kind !== "source_material") continue;
    out.push({
      id: `ev:node:${node.id}`,
      at: node.createdAt,
      text: `Attached · ${node.title}`,
      tone: "line",
    });
  }

  for (const decision of decisions) {
    const at = decision.at ?? "";
    if (decision.kind === "approve" && decision.stage === stage) {
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

/**
 * CL-8899: a model hand-off's `[switch]`-marked first line, read back off
 * the sent mail itself as a boundary event -- the record is the mail
 * (`use-model-handoff.ts`'s `composeModelHandoff`), not something
 * synthesized only for display. `thread.tsx` strips the same marker line off
 * the message's own bubble so the announcement is not shown twice.
 */
export function switchEvents(messages: readonly ChatMessage[]): StageEvent[] {
  const out: StageEvent[] = [];
  for (const message of messages) {
    if (!message.body.startsWith(SWITCH_MARKER_PREFIX)) continue;
    const newline = message.body.indexOf("\n");
    const firstLine = newline < 0 ? message.body : message.body.slice(0, newline);
    const line = firstLine.slice(SWITCH_MARKER_PREFIX.length).trim();
    out.push({ id: `ev:switch:${message.id}`, at: message.at, text: line, tone: "boundary" });
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
