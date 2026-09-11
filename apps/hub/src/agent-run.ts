/**
 * Running a stage specialist.
 *
 * The sequence is deliberate: gather the approved inputs, draft, validate at
 * the boundary, persist as a version, and stop. A draft that never reaches
 * `writeArtifact` is not an artifact, and nothing downstream can approve it.
 */
import { agentFor, panelPrincipals, type AgentRole } from "@solutions-builder/app/kit";
import { assumptionsIn, questionsIn, summaryIn } from "@solutions-builder/app/document";
import { renderStageContext, stageContext, type StageContext } from "./agent-conversation.js";
import { appendHumanTurn, appendSpecialistTurn, type Quote } from "./hub-conversation.js";
import { beginLiveDraft, endLiveDraft, stripOuterFence, updateLiveDraft } from "./live-drafts.js";
import { complete } from "./inference.js";
import { readArtifactNode, writeArtifact } from "./projects.js";
import { database } from "./db.js";
import * as table from "./schema.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type } from "arktype";
import { ArtifactDraft } from "./domain.js";
import { HostError, ReplyCutShort } from "./errors.js";
import {
  DESIGNER_TOKENS_DEFAULT,
  DESIGNER_TOKENS_MAX,
  cutShortTwice,
  designerGuidance,
  designerSettings,
  lowerResolutionGuidance,
  saveDesignerSettings,
} from "./designer-settings.js";
import type { Stage } from "@solutions-builder/app/ledger";

export type StageDraftResult = {
  nodeId: string;
  artifactId: string;
  version: number;
  contentHash: string;
  agent: string;
  providerId: string;
  model: string;
  content: string;
  /** Something the person should hear about how this draft came to be. */
  note?: string;
};

/**
 * Approved source material for a stage: every artifact node on this branch from
 * an earlier stage that has not been superseded. Superseded versions are
 * retained for history but are not what a later stage builds on.
 */
async function approvedInputs(projectId: string, stage: Stage) {
  const { db } = database();
  const nodes = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, projectId),
        isNull(table.artifactNode.supersededByNodeId),
      ),
    )
    .orderBy(asc(table.artifactNode.stage));

  const relevant = nodes.filter((node) => node.stage < stage);
  return Promise.all(
    relevant.map(async (node) => {
      const { content } = await readArtifactNode(node.id);
      return { node, content };
    }),
  );
}

function renderInputs(
  inputs: { node: { title: string; kind: string; stage: number }; content: string }[],
): string {
  if (inputs.length === 0) return "(No earlier approved artifacts. This is the first stage.)";
  return inputs
    .map(
      (input) =>
        `--- APPROVED INPUT: ${input.node.title} (stage ${input.node.stage}, ${input.node.kind}) ---\n${input.content}`,
    )
    .join("\n\n");
}

/**
 * The draft prompt.
 *
 * Pure, and exported, so the two properties that matter can be checked without
 * a provider: that a revision carries the document it is revising, and that
 * the standing directions travel with it.
 *
 * Without the current version in the prompt the model re-rolls the stage from
 * scratch and version two is a different draft rather than a better one, which
 * is not what "revise" means to anyone.
 */
export function buildDraftPrompt(args: {
  projectTitle: string;
  stage: number;
  inputs: string;
  userInput: string;
  currentDocument?: string;
  context?: StageContext;
}): string {
  const revising = (args.currentDocument ?? "").trim().length > 0;
  const conversation = args.context ? renderStageContext(args.context) : "";

  return [
    `Project: ${args.projectTitle}`,
    "",
    args.inputs,
    ...(revising
      ? ["", "--- THE CURRENT VERSION OF THIS DOCUMENT ---", args.currentDocument!.trim()]
      : []),
    ...(conversation ? ["", conversation] : []),
    "",
    "--- WHAT THE PERSON IS ASKING FOR NOW ---",
    args.userInput.trim() ||
      (revising
        ? "(No further instruction. Improve the current version without changing what was agreed.)"
        : "(The user gave no further input; work from the approved inputs above.)"),
    "",
    revising
      ? `Produce the next version of the stage ${args.stage} artifact. Revise the current version above rather than starting over: keep every part that was not objected to, apply what is asked for, and honour the standing directions. Use exactly the headings your instructions specify.`
      : `Produce the stage ${args.stage} artifact now, using exactly the headings your instructions specify.`,
  ].join("\n");
}

async function draftWith(
  agent: AgentRole,
  args: {
    projectId: string;
    stage: Stage;
    runId: string;
    actor: { principalId: string };
    userInput: string;
    projectTitle: string;
    variant?: string;
    titleSuffix?: string;
    /** The version being revised, when this draft is a revision of one. */
    currentDocument?: string;
    context?: StageContext;
  },
): Promise<StageDraftResult> {
  const inputs = await approvedInputs(args.projectId, args.stage);
  if (!agent.produces) {
    throw new HostError("validation_failed", `${agent.title} produces no artifact; it cannot draft.`);
  }

  const prompt = buildDraftPrompt({
    projectTitle: args.projectTitle,
    stage: args.stage,
    inputs: renderInputs(inputs),
    userInput: args.userInput,
    ...(args.currentDocument === undefined ? {} : { currentDocument: args.currentDocument }),
    ...(args.context === undefined ? {} : { context: args.context }),
  });

  // The designer draws to the person's settings: the surface and design
  // language go into its instructions, the token limit is theirs, and what
  // happens when a design is cut short is their policy.
  const designer = agent.produces === "design_artifact" ? await designerSettings() : null;
  let system = designer ? `${agent.system}\n\n${designerGuidance(designer)}` : agent.system;
  let maxTokens = designer?.maxTokens ?? DESIGNER_TOKENS_DEFAULT;
  const firstLimit = maxTokens;
  let note: string | undefined;

  beginLiveDraft(args.projectId, args.stage);
  let result: Awaited<ReturnType<typeof complete>>;
  let cleaned: string;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        result = await complete({
          system,
          prompt,
          temperature: agent.temperature,
          maxTokens,
          onText: (text) => updateLiveDraft(args.projectId, args.stage, stripOuterFence(text)),
        });
        // Models wrap output in a code fence even when told not to. Stripping
        // one outer fence is a kindness to the reviewer, not a licence to
        // reinterpret the draft: nothing else about the text is touched.
        cleaned = stripOuterFence(result.text);
        // A design is one HTML document, and one that stops before its
        // closing tag was cut short on the way here: a dropped stream, a
        // limit the provider did not report. The preview would show its
        // background and nothing else, so it is refused rather than recorded.
        if (/^\s*<(!doctype html|html)\b/i.test(cleaned) && !/<\/html>\s*$/i.test(cleaned)) {
          throw new ReplyCutShort(
            `${agent.title} returned a design cut short after ${cleaned.length} characters: the document has no closing tag. Nothing was recorded.`,
            maxTokens,
          );
        }
        break;
      } catch (cause) {
        // One more attempt, and only for a design, and only as the person's
        // settings say. Anything else is the failure it was.
        if (!(cause instanceof ReplyCutShort) || !designer) throw cause;
        // The retry was cut short as well. Said as the second failure it is,
        // not as a repeat of the first: the person needs to know the policy
        // ran and was not enough.
        if (attempt > 0) {
          throw new ReplyCutShort(
            cutShortTwice({
              title: agent.title,
              onLimit: designer.onLimit === "raise" ? "raise" : "reduce",
              firstLimit,
              secondLimit: maxTokens,
            }),
            cause.limit,
          );
        }
        const limit = maxTokens;
        if (designer.onLimit === "raise") {
          const raised = Math.min(limit * 2, DESIGNER_TOKENS_MAX);
          if (raised <= limit) throw cause;
          await saveDesignerSettings({ maxTokens: raised });
          maxTokens = raised;
          note = `The first attempt was cut short at the ${limit}-token limit. The limit is now ${raised} (Settings, Designer), and this version was produced within it.`;
        } else if (designer.onLimit === "reduce") {
          system = `${system}\n\n${lowerResolutionGuidance(limit)}`;
          note = `The first attempt was cut short at the ${limit}-token limit. This version is a lower-resolution design produced within it; raise the limit in Settings, Designer, for a fuller one.`;
        } else {
          throw new ReplyCutShort(
            `${cause.message} In Settings, Designer, you can raise the limit, or have the designer retry at lower resolution.`,
            cause.limit,
          );
        }
      }
    }
  } finally {
    endLiveDraft(args.projectId, args.stage);
  }

  if (!cleaned.trim()) {
    throw new HostError(
      "provider_unavailable",
      `${agent.title} returned an empty draft. The model or provider failed; nothing was recorded.`,
      {},
      true,
    );
  }
  console.log(
    `${agent.title}: ${cleaned.length} characters, ${result.outputTokens ?? "unknown"} output tokens, ${result.model}`,
  );

  // Boundary validation, once, here. Persistence is what makes it an artifact.
  const draft = ArtifactDraft({
    projectId: args.projectId,
    kind: agent.produces,
    ...(args.variant === undefined ? {} : { variant: args.variant }),
    title: args.titleSuffix
      ? `${agent.title} — ${args.titleSuffix}`
      : `${agent.title} — stage ${args.stage}`,
    content: cleaned,
    // Stage 4 produces a self-contained HTML mockup; everything else is
    // Markdown. The media type is what the design preview renders from.
    mediaType: agent.produces === "design_artifact" ? "text/html" : "text/markdown",
    sourceVersionIds: inputs.map((input) => (input.node as { id: string }).id),
    provenance: {
      producer: "agent",
      agentRole: agent.id,
      providerId: result.providerId,
      model: result.model,
      runId: args.runId,
      promptKey: agent.promptKey,
      promptVersion: 1,
      modelKey: agent.modelKey ?? `sb-model-${agent.id}`,
      assumptions: assumptionsIn(cleaned),
      questions: questionsIn(cleaned),
    },
  });
  if (draft instanceof type.errors) {
    throw new HostError("validation_failed", `The draft failed boundary validation: ${draft.summary}`);
  }

  const written = await writeArtifact(draft, args.actor);

  return {
    ...(note === undefined ? {} : { note }),
    ...written,
    agent: agent.id,
    providerId: result.providerId,
    model: result.model,
    content: result.text,
  };
}

/**
 * Drafts or revises the stage artifact, and records the exchange.
 *
 * The order matters. Context is gathered before the person's new message is
 * recorded, so the message being acted on appears once — as the instruction —
 * rather than twice. Both turns are written only after the draft succeeds: a
 * provider failure leaves the thread as it was, and the person's text is still
 * in the box in front of them.
 */
export async function draftStageArtifact(args: {
  projectId: string;
  stage: Stage;
  runId: string;
  actor: { principalId: string };
  userInput: string;
  projectTitle: string;
  quotes?: Quote[];
  /**
   * `interview` revises the document mid-conversation: the answer just given
   * is folded into a new version, but the questions already queued are left
   * alone and the specialist says nothing here — the next question is its
   * turn to speak. Without this the document sat unchanged until the last
   * answer, so a person answered five questions and watched nothing happen.
   */
  mode?: "interview" | "final";
}): Promise<StageDraftResult> {
  const current = await currentStageDocument(args.projectId, args.stage);
  const context = await stageContext({
    projectId: args.projectId,
    stage: args.stage,
    runId: args.runId,
    actor: args.actor,
  });

  const result = await draftWith(agentFor(args.stage), {
    ...args,
    ...(current === null ? {} : { currentDocument: current }),
    context,
  });

  // Saying nothing is not a turn. Recording one anyway put an empty bubble in
  // the transcript that the UI then had to label "(no note)" — a message from
  // the person that they never wrote.
  if (args.userInput.trim().length > 0 || (args.quotes?.length ?? 0) > 0) {
    await appendHumanTurn({
      projectId: args.projectId,
      runId: args.runId,
      stage: args.stage,
      body: args.userInput,
      actor: args.actor,
      ...(args.quotes && args.quotes.length > 0 ? { quotes: args.quotes } : {}),
    });
  }
  if (args.mode === "interview") {
    // The caller speaks next, with the following question.
    return result;
  }

  // Every question the draft ended with, in order, rides on the turn that
  // opens the round. The first is spoken now; the rest are asked one per
  // exchange, and `nextQuestion` counts the answers on the thread.
  const asked = questionsIn(result.content);

  await appendSpecialistTurn({
    projectId: args.projectId,
    runId: args.runId,
    stage: args.stage,
    actor: args.actor,
    // What the specialist says, not what it did. The draft sits beside the
    // conversation, so repeating its digest here made the question at the end
    // read as one more bullet. The turn is the question; the document is the
    // document.
    body: (() => {
      // How the draft came to be, when that is worth hearing: a design
      // produced at lower resolution, a limit that was raised.
      const lead = result.note ? `${result.note}\n\n` : "";
      if (asked[0]) return `${lead}The draft is beside this. Before I revise it:\n\n${asked[0]}`;
      // Nothing to ask is still a turn: the reader has to be told the ball is
      // theirs, or a finished draft and a stalled one look the same. Told
      // without claiming, in the specialist's voice, that it needs nothing:
      // its summary sometimes names things "newly open" while its questions
      // section says none, and "Nothing I need to ask" under that read as a
      // contradiction. What is true is that no question is queued.
      const summary = summaryIn(result.content) ?? `Here is version ${result.version}.`;
      return `${lead}${summary}\n\nAnything to change before you approve it?`;
    })(),
    resultNodeId: result.nodeId,
    questions: asked,
  });

  return result;
}

/** The live version of this stage's document, or null before there is one. */
async function currentStageDocument(
  projectId: string,
  stage: Stage,
): Promise<string | null> {
  const { db } = database();
  const [node] = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, projectId),
        eq(table.artifactNode.stage, stage),
        isNull(table.artifactNode.supersededByNodeId),
      ),
    )
    .orderBy(asc(table.artifactNode.version));
  if (!node) return null;
  const { content } = await readArtifactNode(node.id);
  return content;
}

/**
 * Stage 5 produces one package per named audience — "one audience means one
 * package; four means four". Each is drafted separately and addressed to that
 * audience, because a security reviewer and a department head do not need the
 * same one-pager. They are siblings on the branch, not versions of each other.
 */
export async function draftAudiencePackages(args: {
  projectId: string;
  runId: string;
  actor: { principalId: string };
  projectTitle: string;
  audiences: { name: string; role: string }[];
  userInput: string;
}): Promise<StageDraftResult[]> {
  if (args.audiences.length === 0) {
    throw new HostError(
      "validation_failed",
      "No audiences are named for this project. Stage 5 needs at least one, " +
        "and who must decide is the user's call, not the product's.",
    );
  }

  const packages: StageDraftResult[] = [];
  for (const audience of args.audiences) {
    packages.push(
      await draftWith(agentFor(5), {
        ...args,
        stage: 5,
        variant: audience.name,
        titleSuffix: audience.name,
        userInput: [
          `Prepare the package for one audience only: ${audience.name} (${audience.role.replace(/_/g, " ")}).`,
          `Use the "## Audience: ${audience.name}" heading and its four subsections.`,
          args.userInput,
        ]
          .filter(Boolean)
          .join("\n\n"),
      }),
    );
  }
  return packages;
}

/**
 * Regenerates a design from recorded feedback.
 *
 * The designer is handed the deterministic revision prompt rather than a chat
 * history, which is what makes the resulting version attributable to exactly
 * the feedback that was submitted. Dispositions are then carried forward, and
 * anchors that no longer resolve are reported as stale.
 */
export async function redesignFromFeedback(args: {
  projectId: string;
  designNodeId: string;
  runId: string;
  actor: { principalId: string };
  projectTitle: string;
}): Promise<StageDraftResult & { stale: string[] }> {
  const { feedbackFor, recordDisposition } = await import("./design-feedback.js");
  const stored = await feedbackFor(args.designNodeId);
  if (!stored) {
    throw new HostError(
      "validation_failed",
      "No feedback has been submitted against that design version.",
    );
  }

  const result = await draftWith(agentFor(4), {
    ...args,
    stage: 4,
    userInput: stored.prompt,
  });

  // Every comment is dispositioned rather than left implicit. `addressed` is the
  // designer's claim; the human reviewing the next version is what tests it.
  const { stale } = await recordDisposition({
    designNodeId: args.designNodeId,
    newDesignNodeId: result.nodeId,
    dispositions: stored.feedback.comments.map((comment) => ({
      commentId: comment.id,
      disposition: "addressed" as const,
    })),
    actor: args.actor,
  });

  return { ...result, stale };
}

/**
 * Stage 6 runs the panel after the architect, against the plan the architect
 * just wrote — which is why it is a second call and not a longer prompt.
 */
export async function runEngineeringReview(args: {
  projectId: string;
  runId: string;
  actor: { principalId: string };
  projectTitle: string;
  plan: string;
}): Promise<StageDraftResult[]> {
  // Four principals, four runs, four artifacts. They are siblings on the
  // branch — variants of one kind, like the stage-5 packages — not versions of
  // each other, because a platform finding does not supersede a security one.
  //
  // Sequential rather than parallel: a provider that rate-limits under four
  // concurrent calls would turn a review into a partial review, and a partial
  // panel is the synthetic-reviewer failure by another route.
  const reviews: StageDraftResult[] = [];
  for (const principal of panelPrincipals()) {
    reviews.push(
      await draftWith(principal, {
        ...args,
        stage: 6,
        variant: principal.id.replace("senior-engineer-", ""),
        titleSuffix: principal.title.replace("Senior engineer — ", ""),
        userInput: `Review this build plan.\n\n${args.plan}`,
      }),
    );
  }
  return reviews;
}
