/**
 * Requesting a stage's specialist to draft, and waiting for it to answer.
 *
 * A drafting round is a `stage.draft` ledger command like any other: it
 * commits, and `runGateSideEffects` delivers it as the round signal the
 * stage's parked loop iteration is waiting on. What makes it a *drafting*
 * request rather than any other round command is the prompt this module
 * builds and hands over in the payload — the iteration's own agent steps
 * read it straight off `steps.round.output.prompt` (or `.prompts[i]` for
 * stage 5's audience fan-out), never anything the host calls directly.
 * `requestDraft` is the whole round trip: build the prompt(s), commit the
 * command, confirm the run actually heard it, wait for its agent steps to
 * answer, and persist each answer as a version. Waiting is the other half —
 * see `awaitIterationOutputs` below.
 *
 * Never a fallback: a round with no run waiting for it is a failure the
 * caller sees (`HostError("provider_unavailable", …)`), not a model call
 * made in-process instead.
 */
import { type } from "arktype";
import { agentById, agentFor, panelPrincipals, type AgentRole } from "@solutions-builder/app/kit";
import { assumptionsIn, questionsIn } from "@solutions-builder/app/document";
import {
  DRAFT_STEP_ID,
  DRAFT_STEP_TIMEOUT_MS,
  EVALUATE_STEP_ID,
  REQUIREMENTS_STEP_ID,
  agentStepIds,
} from "@solutions-builder/app/workflows/stage-loop";
import type { ArtifactKind } from "@solutions-builder/app/artifacts";
import type { Stage } from "@solutions-builder/app/ledger";
import type { HubRunEvent } from "./hub-client.js";
import { readOutputRef, stageIterations, type StageIteration } from "./hub-executor.js";
import { expectLiveDraft, stripOuterFence } from "./live-drafts.js";
import { execute, type Actor } from "./engine.js";
import { readArtifactNode, writeArtifact } from "./projects.js";
import { readProject } from "./project-tenant.js";
import { stageContext } from "./agent-conversation.js";
import { renderInputs, buildDraftPrompt, withChoiceReminder, ensureChoiceSection, type Inputs, type Quote } from "@solutions-builder/app/stage-prompt";
import { database } from "./db.js";
import * as table from "./schema.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { newId } from "./ids.js";
import { ArtifactDraft } from "./domain.js";
import { HostError, ReplyCutShort } from "./errors.js";
import { packageOutlineProblem } from "@solutions-builder/app/deck";
import { providerServingModel } from "./catalog.js";
import { MATERIAL_KIND, materialText } from "./source-material.js";
import { DECK_KIND, writeDeckFor } from "./deck.js";
import { DEFAULT_DECK_DESIGN, deckGuidance, deckSettings, type DeckDesign } from "./deck-settings.js";
import {
  cutShortTwice,
  DESIGNER_TOKENS_MAX,
  designerGuidance,
  designerSettings,
  lowerResolutionGuidance,
  saveDesignerSettings,
} from "./designer-settings.js";

/**
 * The output cap a written document's round runs under. The runtime's own
 * default is 4096 tokens, which cut a build plan or an audience package
 * short; a design takes the person's limit from Settings instead.
 */
const DOCUMENT_OUTPUT_TOKENS = 16_000;

export type StageDraftResult = {
  nodeId: string;
  artifactId: string;
  version: number;
  contentHash: string;
  agent: string;
  providerId: string;
  model: string;
  content: string;
};

/**
 * Approved source material for a stage: every artifact node on this branch from
 * an earlier stage that has not been superseded. Superseded versions are
 * retained for history but are not what a later stage builds on. `sameStage`
 * names the kinds written this stage that a later step of it reads too: the
 * plan is written against the requirements the stage itself produced.
 */
async function approvedInputs(projectId: string, stage: Stage, sameStage: readonly ArtifactKind[] = []) {
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

  // What the person handed over is read at every stage, the first included;
  // what earlier stages approved is read at the stages after them. A deck is
  // bytes built from a package the model already reads, never an input.
  const relevant = nodes.filter(
    (node) =>
      node.kind !== DECK_KIND &&
      (node.kind === MATERIAL_KIND || node.stage < stage || (node.stage === stage && sameStage.includes(node.kind as ArtifactKind))),
  );
  return Promise.all(
    relevant.map(async (node) => {
      const { content } = await readArtifactNode(node.id);
      return { node, content: node.kind === MATERIAL_KIND ? await materialText(node, content) : content };
    }),
  );
}

/** The rendered inputs a stage's specialist would be handed, for a smoke to read. */
export async function stageInputsForSmoke(projectId: string, stage: Stage): Promise<string> {
  return renderInputs(await approvedInputs(projectId, stage), stage);
}

/**
 * The live version of one of this stage's documents, or null before there is
 * one. By kind, since a stage may hold more than one: stage 6 keeps the
 * requirements, the plan and four reviews, and a revision of the plan must
 * carry the plan and not whichever was written first.
 */
async function currentStageDocument(projectId: string, stage: Stage, kind: ArtifactKind): Promise<string | null> {
  const { db } = database();
  const [node] = await db
    .select()
    .from(table.artifactNode)
    .where(
      and(
        eq(table.artifactNode.projectId, projectId),
        eq(table.artifactNode.stage, stage),
        eq(table.artifactNode.kind, kind),
        isNull(table.artifactNode.supersededByNodeId),
      ),
    )
    .orderBy(asc(table.artifactNode.version));
  if (!node) return null;
  const { content } = await readArtifactNode(node.id);
  return content;
}

/** The panel principal a stage 6 `review-<specialty>` step id names. */
function panelPrincipalFor(stepId: string): AgentRole {
  const specialty = stepId.replace(/^review-/, "");
  const found = panelPrincipals().find((entry) => entry.id === `senior-engineer-${specialty}`);
  if (!found) throw new Error(`No panel principal for step ${stepId}`);
  return found;
}

/**
 * The role whose reply an agent step's output is, and the variant the version
 * is recorded under where one kind has several: a stakeholder's package, a
 * principal's review.
 */
function roleForStep(
  stage: Stage,
  stepId: string,
  audiences: readonly { name: string }[],
): { role: AgentRole; variant?: string } {
  if (stage === 5) return { role: agentFor(5), variant: audiences[Number(stepId.replace(/^package-/, ""))]!.name };
  if (stage === 6 && stepId === REQUIREMENTS_STEP_ID) {
    const author = agentById("requirements-author");
    if (!author) throw new Error("requirements-author role missing from the kit");
    return { role: author };
  }
  if (stage === 6 && stepId !== DRAFT_STEP_ID) {
    const role = panelPrincipalFor(stepId);
    return { role, variant: role.title.replace("Senior engineer — ", "") };
  }
  return { role: agentFor(stage) };
}

/**
 * How the platform's default director words a reply that stands in for a
 * failed inference call, one preamble per error category. Mirrors
 * `@intx/inference`'s `default-director.ts`; a step output that named the
 * error itself is the upstream ask, and until then the words are the signal.
 */
const INFERENCE_ERROR_PREAMBLES = [
  "This agent could not complete your request",
  "This agent encountered a temporary error communicating with the inference provider",
  "This agent's inference request was aborted",
];

/** Whether a reply is the director's account of a failed call rather than the model's answer. */
export function isInferenceErrorReply(reply: string): boolean {
  const text = reply.trimStart();
  return INFERENCE_ERROR_PREAMBLES.some((preamble) => text.startsWith(preamble));
}

/**
 * Persists one agent step's reply as an artifact version — the boundary
 * validation and write every drafted stage shares, whatever produced the
 * reply: the stage's own specialist, one of stage 5's audience packages, or
 * one of stage 6's panel reviews.
 */
async function persistOutput(args: {
  projectId: string;
  stage: Stage;
  role: AgentRole;
  reply: string;
  iterationRunId: string;
  stepId: string;
  actor: { principalId: string };
  inputs: { node: { id: string } }[];
  variant?: string;
  brief?: string;
  /** The model the step's turn names — the one the deployment is pinned to. */
  model?: string;
}): Promise<StageDraftResult> {
  const cleaned = stripOuterFence(args.reply);
  const served = args.model ? await providerServingModel(args.model) : null;
  // Who was asked, named in any failure: Settings cannot say which model
  // the host picked among "best available", and the failure has to.
  const asked = args.model ? `${served ? `${served.label} · ` : ""}${args.model}` : "the model";
  if (!cleaned.trim()) {
    throw new HostError(
      "provider_unavailable",
      `${args.role.title} got an empty draft from ${asked}. The model or provider failed; nothing was recorded.`,
      {},
      true,
    );
  }
  // The platform's director answers a failed call with a sentence about the
  // failure, as the agent's reply: the step completes, and nothing in its
  // output says the text is not the model's. Recorded, that sentence would
  // become a version of the document. It is the failure it describes.
  if (isInferenceErrorReply(cleaned)) {
    throw new HostError("provider_unavailable", `${args.role.title} could not get an answer from ${asked}. ${cleaned.trim()}`, {}, true);
  }
  // A design is one HTML document, and one that stops before its closing tag
  // was cut short on the way here: a dropped stream, a limit the run's own
  // provider call hit that nothing here controls any more. The preview would
  // show its background and nothing else, so it is refused rather than
  // recorded — the host no longer retries this itself (there is no host-side
  // call to retry); the person redrafts with fresh instructions instead.
  if (
    args.role.produces === "design_artifact" &&
    /^\s*<(!doctype html|html)\b/i.test(cleaned) &&
    !/<\/html>\s*$/i.test(cleaned)
  ) {
    throw new ReplyCutShort(
      `${args.role.title} returned a design cut short after ${cleaned.length} characters: the document has no closing tag. Nothing was recorded.`,
      null,
    );
  }

  // A stakeholder's package is the source of their slides, so one with no
  // deck outline is refused rather than recorded: the person redrafts, and
  // the thread says what the model left out and who was asked.
  if (args.role.produces === "audience_package") {
    const problem = packageOutlineProblem(cleaned);
    if (problem) {
      throw new HostError(
        "validation_failed",
        `${args.role.title} returned a package${args.variant ? ` for ${args.variant}` : ""} from ${asked} that cannot be recorded: ${problem}. Nothing was recorded; draft it again.`,
        {},
        true,
      );
    }
  }

  const draft = ArtifactDraft({
    projectId: args.projectId,
    kind: args.role.produces,
    ...(args.variant === undefined ? {} : { variant: args.variant }),
    title: args.variant ? `${args.role.title} — ${args.variant}` : `${args.role.title} — stage ${args.stage}`,
    content: cleaned,
    // Stage 4 produces a self-contained HTML mockup; everything else is
    // Markdown. The media type is what the design preview renders from.
    mediaType: args.role.produces === "design_artifact" ? "text/html" : "text/markdown",
    sourceVersionIds: args.inputs.map((input) => input.node.id),
    provenance: {
      producer: "agent",
      agentRole: args.role.id,
      runId: args.iterationRunId,
      promptKey: args.role.promptKey,
      promptVersion: 1,
      modelKey: args.role.modelKey ?? `sb-model-${args.role.id}`,
      assumptions: assumptionsIn(cleaned),
      questions: questionsIn(cleaned),
      stepRef: `${args.iterationRunId}/${args.stepId}`,
      ...(args.brief ? { brief: args.brief } : {}),
    },
  });
  if (draft instanceof type.errors) {
    throw new HostError("validation_failed", `The draft failed boundary validation: ${draft.summary}`);
  }

  const written = await writeArtifact(draft, args.actor);
  return {
    ...written,
    agent: args.role.id,
    providerId: served?.providerId ?? "",
    model: args.model ?? args.role.modelKey ?? "",
    content: args.reply,
  };
}

export type StageDraftRequest = {
  draft: StageDraftResult;
  /** Stage 5 only: one package per named audience, in policy order; `draft` is the first. */
  packages: StageDraftResult[] | null;
  /**
   * Stage 5 only: the stakeholders whose package could not be written this
   * round, with the reason. The packages that were written are recorded
   * regardless, so a person retries these alone.
   */
  failed?: { audience: string; message: string }[];
  /** Stage 6 only: the four panel reviews of the architect's plan. */
  review: StageDraftResult[] | null;
  /** Stage 6 only: the requirements document, when this request wrote it. */
  requirements: StageDraftResult | null;
  /** Something the person should hear about how this draft came to be: a retry the policy asked for. */
  note?: string;
};

/** Which of stage 6's two documents a request writes. */
export type PlanDocument = "requirements" | "plan";

/** One round's worth of a `stage.draft` command: what it carries, and which agent steps it waits on. */
type Round = {
  /** What the person said, as the thread shows it. Empty on a round that follows one that already carried it. */
  readonly message: string;
  readonly prompt?: string;
  readonly prompts?: string[];
  readonly wanted?: boolean[];
  /** The agent steps this round runs, in run order; a gated step not wanted is not among them. */
  readonly stepIds: readonly string[];
  /** What the round's prompts were rendered from, recorded as each version's sources. */
  readonly inputs: Inputs;
};

type RoundOutcome = {
  persisted: Map<string, StageDraftResult>;
  failed: { audience: string; message: string }[];
};

/**
 * Asks the stage's specialist to draft — or, at stage 5, every audience's
 * package; at stage 6, the requirements in one round and then the architect's
 * plan and the panel's four reviews of it in the next — and waits for the
 * run's agent steps to answer.
 *
 * `mode: "interview"` revises the document mid-conversation: the answer just
 * given is folded into a new version, but the questions already queued are
 * left alone — the thread projection (`stage-thread.ts`), not this function,
 * is what speaks the next one. `mode: "final"` is an ordinary round: the
 * draft opens a fresh round of questions, or none.
 */
export async function requestDraft(args: {
  projectId: string;
  stage: Stage;
  runId: string;
  actor: Actor;
  message: string;
  quotes?: Quote[];
  mode: "interview" | "final";
  projectTitle: string;
  /**
   * Stage 5 only: the stakeholders whose package this round writes, by
   * name. Absent, every stakeholder's. The others' packages are left as
   * they are, and their steps are skipped by the run.
   */
  audiences?: readonly string[];
  /**
   * Stage 6 only: which of its documents to write. Absent, the requirements
   * when the stage has none yet and then the plan; once the requirements
   * exist, the plan alone, so answering the architect's question revises the
   * plan and not the document it is written against.
   */
  documents?: readonly PlanDocument[];
}): Promise<StageDraftRequest> {
  const inputs = await approvedInputs(args.projectId, args.stage);
  const context = await stageContext({ projectId: args.projectId, stage: args.stage });
  const designer = args.stage === 4 ? await designerSettings() : null;

  let prompt: string | undefined;
  let prompts: string[] | undefined;
  let audiences: { name: string; role: string }[] = [];
  /** Stage 5: which of `audiences` this round writes, in the same order. */
  let wanted: boolean[] = [];

  if (args.stage === 5) {
    const project = await readProject(args.projectId);
    audiences = project?.policy.audiences ?? [];
    if (audiences.length === 0) {
      throw new HostError(
        "validation_failed",
        "No audiences are named for this project. Stage 5 needs at least one, " +
          "and who must decide is the user's call, not the product's.",
      );
    }
    const unknown = (args.audiences ?? []).filter((name) => !audiences.some((audience) => audience.name === name));
    if (unknown.length > 0) {
      throw new HostError("validation_failed", `No stakeholder is named ${unknown.map((name) => JSON.stringify(name)).join(", ")}.`);
    }
    wanted = audiences.map((audience) => args.audiences === undefined || args.audiences.includes(audience.name));
    if (!wanted.some(Boolean)) {
      throw new HostError("validation_failed", "No stakeholder was named to write a package for.");
    }
    // Each stakeholder's package follows the deck design their role was
    // given in Settings: what the outline should cover and lead with.
    const decks = await deckSettings();
    prompts = audiences.map((audience) =>
      buildDraftPrompt({
        projectTitle: args.projectTitle,
        stage: args.stage,
        inputs: renderInputs(inputs, args.stage),
        userInput: [
          `Prepare the package for one audience only: ${audience.name} (${audience.role.replace(/_/g, " ")}).`,
          `Use the "## Audience: ${audience.name}" heading and its four subsections.`,
          deckGuidance(audience.role, (decks as Record<string, DeckDesign>)[audience.role] ?? DEFAULT_DECK_DESIGN) ?? "",
          args.message,
        ]
          .filter(Boolean)
          .join("\n\n"),
      }),
    );
  } else if (args.stage === 6) {
    // Stage 6's prompts are built per round, below: the plan's carries the
    // requirements, which the first round may only just have written.
    if (args.documents !== undefined && args.documents.length === 0) {
      throw new HostError("validation_failed", "No document was named to write at stage 6.");
    }
  } else {
    const current = await currentStageDocument(args.projectId, args.stage, agentFor(args.stage).produces ?? "problem_brief");
    prompt = buildDraftPrompt({
      projectTitle: args.projectTitle,
      stage: args.stage,
      inputs: renderInputs(inputs, args.stage),
      userInput: withChoiceReminder(args.stage, args.message),
      ...(current === null ? {} : { currentDocument: current }),
      context,
    });
    // The designer's system prompt is fixed at deploy time, so the person's
    // surface and design-language settings cannot live there; they ride on
    // the round's own prompt instead, the one thing that does change per draft.
    if (designer) {
      prompt = `${prompt}\n\n${designerGuidance(designer)}`;
    }
  }

  // The output cap rides on the round too, read by the specialist step's
  // `inference` selector, so a change in Settings applies to the next draft
  // with nothing redeployed. The designer's policy for a design cut short
  // is a second round: at a raised cap, or at lower resolution within it.
  let maxTokens = designer?.maxTokens ?? DOCUMENT_OUTPUT_TOKENS;
  const firstLimit = maxTokens;
  let note: string | undefined;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await draftAt(maxTokens);
      return note === undefined ? result : { ...result, note };
    } catch (cause) {
      // One more round, only for a design, only as the person's settings
      // say. Anything else is the failure it was.
      if (!(cause instanceof ReplyCutShort) || !designer) throw cause;
      if (attempt > 0) {
        throw new ReplyCutShort(
          cutShortTwice({
            title: agentFor(args.stage).title,
            onLimit: designer.onLimit === "raise" ? "raise" : "reduce",
            firstLimit,
            secondLimit: maxTokens,
          }),
          maxTokens,
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
        prompt = `${prompt}\n\n${lowerResolutionGuidance(limit)}`;
        note = `The first attempt was cut short at the ${limit}-token limit. This version is a lower-resolution design produced within it; raise the limit in Settings, Designer, for a fuller one.`;
      } else {
        throw new ReplyCutShort(
          `${cause.message} In Settings, Designer, you can raise the limit, or have the designer retry at lower resolution.`,
          limit,
        );
      }
    }
  }

  /** The stage's rounds at one output cap, and the versions they recorded. */
  async function draftAt(cap: number): Promise<StageDraftRequest> {
    if (args.stage === 5) {
      const stepIds = agentStepIds(5, audiences.length).filter((_stepId, index) => wanted[index]);
      const { persisted, failed } = await round(cap, { message: args.message, prompts: prompts ?? [], wanted, stepIds, inputs });
      const packages = stepIds.flatMap((id) => persisted.get(id) ?? []);
      const draft = packages[0];
      if (!draft) {
        if (failed.length > 0) {
          throw new HostError(
            "provider_unavailable",
            failed.map((entry) => `The package for ${entry.audience} could not be written. ${entry.message}`).join(" "),
            {},
            true,
          );
        }
        throw new HostError("internal_error", "Stage 5 produced no draft output.");
      }
      return { draft, packages, review: null, requirements: null, ...(failed.length > 0 ? { failed } : {}) };
    }

    if (args.stage === 6) return await planRounds(cap);

    const stepIds = agentStepIds(args.stage, 0);
    const { persisted } = await round(cap, { message: args.message, prompt: prompt ?? "", stepIds, inputs });
    const draft = persisted.get(DRAFT_STEP_ID);
    if (!draft) throw new HostError("internal_error", `Stage ${args.stage} produced no draft output.`);
    return { draft, packages: null, review: null, requirements: null };
  }

  /**
   * Stage 6: the requirements in a round of their own, then the plan and its
   * reviews in the next. Two rounds rather than one chain of steps because
   * the architect's prompt is built by the host, with the requirements as an
   * input beside the approved ones, and the host only has them once the
   * first round has answered. The person's message rides the first round
   * that runs; the thread shows it once.
   */
  async function planRounds(cap: number): Promise<StageDraftRequest> {
    const existing = await currentStageDocument(args.projectId, 6, "product_requirements");
    const documents: readonly PlanDocument[] = args.documents ?? (existing === null ? ["requirements", "plan"] : ["plan"]);

    let requirements: StageDraftResult | null = null;
    if (documents.includes("requirements")) {
      const requirementsPrompt = buildDraftPrompt({
        projectTitle: args.projectTitle,
        stage: 6,
        inputs: renderInputs(inputs, 6),
        userInput: args.message,
        ...(existing === null ? {} : { currentDocument: existing }),
        context,
      });
      const { persisted } = await round(cap, {
        message: args.message,
        prompts: [requirementsPrompt, ""],
        wanted: [true, false],
        stepIds: [REQUIREMENTS_STEP_ID],
        inputs,
      });
      requirements = persisted.get(REQUIREMENTS_STEP_ID) ?? null;
      if (!requirements) throw new HostError("internal_error", "Stage 6 produced no requirements document.");
    }
    if (!documents.includes("plan")) {
      return { draft: requirements!, packages: null, review: null, requirements };
    }

    const planInputs = await approvedInputs(args.projectId, 6, ["product_requirements"]);
    const currentPlan = await currentStageDocument(args.projectId, 6, "build_plan");
    const planPrompt = buildDraftPrompt({
      projectTitle: args.projectTitle,
      stage: 6,
      inputs: renderInputs(planInputs, 6),
      userInput: args.message,
      ...(currentPlan === null ? {} : { currentDocument: currentPlan }),
      context,
    });
    const stepIds = agentStepIds(6, 0).filter((id) => id !== REQUIREMENTS_STEP_ID);
    const { persisted } = await round(cap, {
      message: requirements === null ? args.message : "",
      prompts: ["", planPrompt],
      wanted: [false, true],
      stepIds,
      inputs: planInputs,
    });
    const draft = persisted.get(DRAFT_STEP_ID);
    if (!draft) throw new HostError("internal_error", "Stage 6 produced no plan.");
    const review = stepIds.filter((id) => id !== DRAFT_STEP_ID).map((id) => persisted.get(id)!);
    return { draft, packages: null, review, requirements };
  }

  /** One drafting round: the command, the run's answer, and its versions. */
  async function round(cap: number, plan: Round): Promise<RoundOutcome> {
    expectLiveDraft(args.projectId, args.stage);

    // The iteration this round will run in is either already visible (parked,
    // awaiting the very signal about to be delivered) or not yet spawned.
    // `awaitIterationOutputs` tells the two apart from this snapshot.
    const before = await stageIterations(args.projectId, args.stage, { currentOnly: true });

    const outcome = await execute({
      type: "stage.draft",
      actor: args.actor,
      projectId: args.projectId,
      idempotencyKey: newId.command(),
      correlationId: newId.correlation(),
      payload: {
        runId: args.runId,
        message: plan.message,
        ...(args.quotes && args.quotes.length > 0 ? { quotes: args.quotes } : {}),
        mode: args.mode,
        ...(plan.prompt !== undefined ? { prompt: plan.prompt } : {}),
        ...(plan.prompts !== undefined ? { prompts: plan.prompts, wanted: plan.wanted } : {}),
        ...(context.brief ? { brief: context.brief } : {}),
        inference: { maxTokens: cap },
      },
    });

    if (outcome.delivery !== "delivered") {
      throw new HostError(
        "provider_unavailable",
        `Stage ${args.stage} has no run waiting for this stage; nothing was drafted.`,
        {},
        true,
      );
    }

    // A stakeholder's package failing is that package's failure, not the
    // round's: the others are recorded and the failed ones are reported, so
    // the person retries those alone. Every other stage's steps depend on
    // each other, so there the first failure is the round's.
    const { runId: iterationRunId, outputs, failures } = await awaitIterationOutputs({
      projectId: args.projectId,
      stage: args.stage,
      before,
      stepIds: plan.stepIds,
      timeoutMs: DRAFT_STEP_TIMEOUT_MS,
      settle: args.stage === 5,
    });
    const audienceOf = (stepId: string) => audiences[Number(stepId.replace(/^package-/, ""))]!.name;
    const failed: { audience: string; message: string }[] = [...failures].map(([stepId, message]) => ({
      audience: audienceOf(stepId),
      message,
    }));

    const persisted = new Map<string, StageDraftResult>();
    for (const stepId of plan.stepIds) {
      // The evaluator is advisory and produces nothing an approver reviews;
      // its verdict is read back through `evaluationIn`, never written here.
      if (stepId === EVALUATE_STEP_ID) continue;
      const output = outputs.get(stepId);
      if (!output) continue;

      const { role, variant } = roleForStep(args.stage, stepId, audiences);
      // Only a document's own prompt drew on the compacted brief; a panel
      // review or an audience package was never handed it.
      const drewOnBrief = stepId === DRAFT_STEP_ID || stepId === REQUIREMENTS_STEP_ID;

      try {
        const result = await persistOutput({
          projectId: args.projectId,
          stage: args.stage,
          role,
          // A stage-3 draft that ignored the choice reminder still records
          // the choice: without the section the workspace keeps asking.
          reply: ensureChoiceSection(args.stage, plan.message, output.reply),
          iterationRunId,
          stepId,
          actor: args.actor,
          inputs: plan.inputs,
          ...(typeof output.turn?.model === "string" ? { model: output.turn.model } : {}),
          ...(variant !== undefined ? { variant } : {}),
          ...(drewOnBrief && context.brief ? { brief: context.brief } : {}),
        });
        persisted.set(stepId, result);
        // Every stakeholder's package carries a deck outline (persistOutput
        // refused it otherwise); the slides are built from it and kept beside
        // the package. A deck the renderer cannot produce is logged, not a
        // failure of the package it came from: the outline is still there,
        // and "Save slides" builds from it again.
        if (args.stage === 5 && variant !== undefined) {
          const audience = audiences.find((entry) => entry.name === variant)!;
          await writeDeckFor({
            projectId: args.projectId,
            projectTitle: args.projectTitle,
            audience,
            packageNodeId: result.nodeId,
            markdown: result.content,
            agentRole: role.id,
            actor: args.actor,
          }).catch((cause: unknown) => {
            console.error(`[stage 5] ${args.projectId}: the slides for ${variant} could not be built:`, cause);
          });
        }
      } catch (cause) {
        // An empty, cut-short or outline-less package is that package's failure too.
        if (args.stage !== 5 || !(cause instanceof HostError)) throw cause;
        failed.push({ audience: audienceOf(stepId), message: cause.message });
      }
    }

    return { persisted, failed };
  }
}

// --- Waiting for the round's agent steps to answer --------------------------

const POLL_INTERVAL_MS = 500;

function eventBody(event: HubRunEvent): Record<string, unknown> {
  return event.body;
}

function findEvent(events: HubRunEvent[], kind: string, stepId: string): HubRunEvent | undefined {
  return events.find((event) => event.type === kind && eventBody(event).stepId === stepId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An agent step's output: the reply, and the turn that produced it, which names the model. */
export type StepReply = { reply: string; turn?: { model?: string } };

/**
 * Waits for the newest iteration beyond `afterIteration` to complete every
 * step in `stepIds`, and returns each one's resolved `{reply}` output.
 * Throws `HostError("provider_unavailable", …)` the moment any of them fails,
 * quoting the run's own error message, and again if nothing has answered by
 * `timeoutMs`. With `settle`, a failed step is not the end: the wait goes
 * on until every step has completed or failed, and the failures come back
 * by step id beside the outputs of the ones that completed.
 */
export async function awaitIterationOutputs(args: {
  readonly projectId: string;
  readonly stage: Stage;
  /**
   * The stage's iterations as they were when the round was requested. The
   * round runs in the last of them when that one is parked awaiting the
   * signal, or in the next one spawned; an iteration that had already
   * settled by then is an earlier round's, whatever its position.
   */
  readonly before: readonly StageIteration[];
  readonly stepIds: readonly string[];
  readonly timeoutMs: number;
  readonly settle?: boolean;
}): Promise<{ runId: string; outputs: Map<string, StepReply>; failures: Map<string, string> }> {
  const deadline = Date.now() + args.timeoutMs;

  // Every step the round is waiting on has completed or failed.
  const settled = (iteration: StageIteration): boolean =>
    args.stepIds.every(
      (stepId) => findEvent(iteration.events, "StepCompleted", stepId) !== undefined || findEvent(iteration.events, "StepFailed", stepId) !== undefined,
    );
  const earlier = new Set(args.before.filter(settled).map((iteration) => iteration.runId));
  const first = Math.max(0, args.before.length - 1);

  for (;;) {
    const iterations = await stageIterations(args.projectId, args.stage, { currentOnly: true });

    // The round's own iteration is the first from the snapshot's last one on
    // that was not already settled then and is settled now. Not the newest:
    // the loop spawns the next iteration, parked on its own round signal,
    // as soon as this one's body ends, and a poll that lands after that
    // spawn would otherwise wait on an iteration nothing will ever draft in.
    for (const iteration of iterations.slice(first)) {
      if (earlier.has(iteration.runId)) continue;
      const anchor = iteration.runId.split("__", 1)[0]!;

      const failures = new Map<string, string>();
      for (const stepId of args.stepIds) {
        const failed = findEvent(iteration.events, "StepFailed", stepId);
        if (!failed) continue;
        const error = eventBody(failed).error as { message?: string } | undefined;
        const message = `The ${stepId} step failed: ${error?.message ?? "no error message was recorded"}.`;
        if (!args.settle) throw new HostError("provider_unavailable", message, {}, true);
        failures.set(stepId, message);
      }

      if (!settled(iteration)) continue;
      const outputs = new Map<string, StepReply>();
      for (const stepId of args.stepIds) {
        const event = findEvent(iteration.events, "StepCompleted", stepId);
        if (!event) continue;
        const output = eventBody(event).output as { ref?: unknown } | undefined;
        if (typeof output?.ref !== "string") {
          throw new HostError("internal_error", `The ${stepId} step completed with no output ref.`);
        }
        outputs.set(stepId, (await readOutputRef(anchor, iteration.runId, output.ref)) as StepReply);
      }
      return { runId: iteration.runId, outputs, failures };
    }

    if (Date.now() >= deadline) {
      throw new HostError(
        "provider_unavailable",
        `No reply arrived for stage ${args.stage} within ${Math.round(args.timeoutMs / 1000)}s.`,
        {},
        true,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
