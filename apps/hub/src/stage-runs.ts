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
import { agentFor, panelPrincipals, type AgentRole } from "@solutions-builder/app/kit";
import { assumptionsIn, questionsIn } from "@solutions-builder/app/document";
import {
  DRAFT_STEP_ID,
  DRAFT_STEP_TIMEOUT_MS,
  EVALUATE_STEP_ID,
  agentStepIds,
} from "@solutions-builder/app/workflows/stage-loop";
import type { Stage } from "@solutions-builder/app/ledger";
import type { HubRunEvent } from "./hub-client.js";
import { readOutputRef, stageIterations } from "./hub-executor.js";
import { expectLiveDraft, stripOuterFence } from "./live-drafts.js";
import { execute, type Actor } from "./engine.js";
import { readArtifactNode, writeArtifact } from "./projects.js";
import { readProject } from "./project-tenant.js";
import { stageContext, renderStageContext, type StageContext, type Quote } from "./agent-conversation.js";
import { database } from "./db.js";
import * as table from "./schema.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { newId } from "./ids.js";
import { ArtifactDraft } from "./domain.js";
import { HostError, ReplyCutShort } from "./errors.js";
import { providerServingModel } from "./catalog.js";
import { MATERIAL_KIND, materialText } from "./source-material.js";
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

  // What the person handed over is read at every stage, the first included;
  // what earlier stages approved is read at the stages after them.
  const relevant = nodes.filter((node) => node.kind === MATERIAL_KIND || node.stage < stage);
  return Promise.all(
    relevant.map(async (node) => {
      const { content } = await readArtifactNode(node.id);
      return { node, content: node.kind === MATERIAL_KIND ? await materialText(node, content) : content };
    }),
  );
}

/** The rendered inputs a stage's specialist would be handed, for a smoke to read. */
export async function stageInputsForSmoke(projectId: string, stage: Stage): Promise<string> {
  return renderInputs(await approvedInputs(projectId, stage));
}

function renderInputs(
  inputs: { node: { title: string; kind: string; stage: number }; content: string }[],
): string {
  if (inputs.length === 0) return "(No earlier approved artifacts. This is the first stage.)";
  return inputs
    .map((input) =>
      input.node.kind === MATERIAL_KIND
        ? `--- MATERIAL THE PERSON PROVIDED: ${input.node.title} ---\n${input.content}`
        : `--- APPROVED INPUT: ${input.node.title} (stage ${input.node.stage}, ${input.node.kind}) ---\n${input.content}`,
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

/** The live version of this stage's document, or null before there is one. */
async function currentStageDocument(projectId: string, stage: Stage): Promise<string | null> {
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

/** The panel principal a stage 6 `review-<specialty>` step id names. */
function panelPrincipalFor(stepId: string): AgentRole {
  const specialty = stepId.replace(/^review-/, "");
  const found = panelPrincipals().find((entry) => entry.id === `senior-engineer-${specialty}`);
  if (!found) throw new Error(`No panel principal for step ${stepId}`);
  return found;
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
  /** Something the person should hear about how this draft came to be: a retry the policy asked for. */
  note?: string;
};

/**
 * Asks the stage's specialist to draft — or, at stage 5, every audience's
 * package, or at stage 6, the architect's plan and then the panel's four
 * reviews of it — and waits for the run's agent steps to answer.
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
    prompts = audiences.map((audience) =>
      buildDraftPrompt({
        projectTitle: args.projectTitle,
        stage: args.stage,
        inputs: renderInputs(inputs),
        userInput: [
          `Prepare the package for one audience only: ${audience.name} (${audience.role.replace(/_/g, " ")}).`,
          `Use the "## Audience: ${audience.name}" heading and its four subsections.`,
          args.message,
        ]
          .filter(Boolean)
          .join("\n\n"),
      }),
    );
  } else {
    const current = await currentStageDocument(args.projectId, args.stage);
    prompt = buildDraftPrompt({
      projectTitle: args.projectTitle,
      stage: args.stage,
      inputs: renderInputs(inputs),
      userInput: args.message,
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
      const result = await round(maxTokens);
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

  /** One drafting round: the command, the run's answer, and its versions. */
  async function round(cap: number): Promise<StageDraftRequest> {
  expectLiveDraft(args.projectId, args.stage);

  const before = await stageIterations(args.projectId, args.stage);
  // The iteration this round will run in is either already visible (parked,
  // awaiting the very signal about to be delivered) or not yet spawned; either
  // way it is not a *new* entry in the list once the round is under way — the
  // loop only advances to a fresh iteration once this one's whole body has
  // finished. One less than the newest index we can already see is what makes
  // `awaitIterationOutputs`' "the newest iteration is beyond where I started"
  // check pass as soon as this round's own iteration exists.
  const afterIteration = before.length - 2;

  const outcome = await execute({
    type: "stage.draft",
    actor: args.actor,
    projectId: args.projectId,
    idempotencyKey: newId.command(),
    correlationId: newId.correlation(),
    payload: {
      runId: args.runId,
      message: args.message,
      ...(args.quotes && args.quotes.length > 0 ? { quotes: args.quotes } : {}),
      mode: args.mode,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(prompts !== undefined ? { prompts, wanted } : {}),
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

  // At stage 5 only the wanted packages' steps run; the rest are skipped by
  // their gates and are not waited on.
  const stepIds = agentStepIds(args.stage, audiences.length).filter(
    (stepId, index) => args.stage !== 5 || wanted[index],
  );
  // A stakeholder's package failing is that package's failure, not the
  // round's: the others are recorded and the failed ones are reported, so
  // the person retries those alone. Every other stage's steps depend on
  // each other, so there the first failure is the round's.
  const { runId: iterationRunId, outputs, failures } = await awaitIterationOutputs({
    projectId: args.projectId,
    stage: args.stage,
    afterIteration,
    stepIds,
    timeoutMs: DRAFT_STEP_TIMEOUT_MS,
    settle: args.stage === 5,
  });
  const audienceOf = (stepId: string) => audiences[Number(stepId.replace(/^package-/, ""))]!.name;
  const failed: { audience: string; message: string }[] = [...failures].map(([stepId, message]) => ({
    audience: audienceOf(stepId),
    message,
  }));

  const persisted = new Map<string, StageDraftResult>();
  for (const stepId of stepIds) {
    // The evaluator is advisory and produces nothing an approver reviews;
    // its verdict is read back through `evaluationIn`, never written here.
    if (stepId === EVALUATE_STEP_ID) continue;
    const output = outputs.get(stepId);
    if (!output) continue;

    const isDraftStep = stepId === DRAFT_STEP_ID;
    const role =
      args.stage === 5 ? agentFor(5) : args.stage === 6 && !isDraftStep ? panelPrincipalFor(stepId) : agentFor(args.stage);
    const variant =
      args.stage === 5
        ? audiences[Number(stepId.replace(/^package-/, ""))]!.name
        : args.stage === 6 && !isDraftStep
          ? role.title.replace("Senior engineer — ", "")
          : undefined;

    try {
      persisted.set(
        stepId,
        await persistOutput({
          projectId: args.projectId,
          stage: args.stage,
          role,
          reply: output.reply,
          iterationRunId,
          stepId,
          actor: args.actor,
          inputs,
          ...(typeof output.turn?.model === "string" ? { model: output.turn.model } : {}),
          ...(variant !== undefined ? { variant } : {}),
          // Only the round's own prompt drew on the compacted brief; a panel
          // review or an audience package was never handed it.
          ...(isDraftStep && context.brief ? { brief: context.brief } : {}),
        }),
      );
    } catch (cause) {
      // An empty or cut-short package is that package's failure too.
      if (args.stage !== 5 || !(cause instanceof HostError)) throw cause;
      failed.push({ audience: audienceOf(stepId), message: cause.message });
    }
  }

  const packages = args.stage === 5 ? stepIds.flatMap((id) => persisted.get(id) ?? []) : null;
  const review = args.stage === 6 ? stepIds.filter((id) => id !== DRAFT_STEP_ID).map((id) => persisted.get(id)!) : null;
  const draft = persisted.get(DRAFT_STEP_ID) ?? packages?.[0];
  if (!draft) {
    if (failed.length > 0) {
      throw new HostError(
        "provider_unavailable",
        failed.map((entry) => `The package for ${entry.audience} could not be written. ${entry.message}`).join(" "),
        {},
        true,
      );
    }
    throw new HostError("internal_error", `Stage ${args.stage} produced no draft output.`);
  }

  return { draft, packages, review, ...(failed.length > 0 ? { failed } : {}) };
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
  readonly afterIteration: number;
  readonly stepIds: readonly string[];
  readonly timeoutMs: number;
  readonly settle?: boolean;
}): Promise<{ runId: string; outputs: Map<string, StepReply>; failures: Map<string, string> }> {
  const deadline = Date.now() + args.timeoutMs;

  for (;;) {
    const iterations = await stageIterations(args.projectId, args.stage);
    const newestIndex = iterations.length - 1;

    if (newestIndex > args.afterIteration) {
      const iteration = iterations[newestIndex]!;
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

      const completed = args.stepIds.map((stepId) => findEvent(iteration.events, "StepCompleted", stepId));
      if (completed.every((event, index) => event !== undefined || failures.has(args.stepIds[index]!))) {
        const outputs = new Map<string, StepReply>();
        for (const [index, stepId] of args.stepIds.entries()) {
          const event = completed[index];
          if (!event) continue;
          const output = eventBody(event).output as { ref?: unknown } | undefined;
          if (typeof output?.ref !== "string") {
            throw new HostError("internal_error", `The ${stepId} step completed with no output ref.`);
          }
          outputs.set(stepId, (await readOutputRef(anchor, iteration.runId, output.ref)) as StepReply);
        }
        return { runId: iteration.runId, outputs, failures };
      }
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
