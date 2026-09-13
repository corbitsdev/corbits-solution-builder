/**
 * The stage conversation and its compactor.
 *
 * Three claims are load-bearing and none of them are obvious from reading the
 * code, so they are checked here: that a revision carries the document it is
 * revising, that compaction never drops the instruction being acted on, and
 * that the thread is projected correctly from a run's own events — including
 * the standing brief, which now travels as a produced version's own
 * `provenance.brief` rather than a separate marker turn.
 */
import { buildDraftPrompt } from "../apps/hub/src/stage-runs.js";
import {
  VERBATIM_BUDGET,
  pendingContext,
  splitForCompaction,
} from "../apps/hub/src/agent-conversation.js";
import { evaluationIn, projectStageThread, threadTurns, type StageTurn } from "../apps/hub/src/stage-thread.js";
import { DRAFT_STEP_ID, EVALUATE_STEP_ID, REQUIREMENTS_STEP_ID, ROUND_STEP_ID } from "@solutions-builder/app/workflows/stage-loop";
import { agentFor } from "@solutions-builder/app/kit";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { mountHub } from "../apps/hub/src/hub-mount.js";
import { createProject, writeArtifact } from "../apps/hub/src/projects.js";
import { install } from "../apps/hub/src/install.js";
import { localActor } from "../apps/hub/src/hub-client.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const turn = (id: string, role: "human" | "specialist", body: string): StageTurn => ({
  id,
  role,
  body,
  quotes: [],
  resultNodeId: null,
  questions: null,
  createdAt: new Date().toISOString(),
});

// --- The prompt ---
{
  const first = buildDraftPrompt({
    projectTitle: "Outreach",
    stage: 1,
    inputs: "(No earlier approved artifacts. This is the first stage.)",
    userInput: "Reps rebuild the same list every Monday.",
  });
  check("a first draft carries no current version", !first.includes("THE CURRENT VERSION"));
  check("a first draft is told to produce", first.includes("Produce the stage 1 artifact now"));

  const revision = buildDraftPrompt({
    projectTitle: "Outreach",
    stage: 1,
    inputs: "(none)",
    currentDocument: "# Problem brief\n\nThe list goes stale.",
    userInput: "Cut the second section.",
    context: {
      brief: "- Never propose replacing the CRM.",
      recent: [turn("m1", "human", "Keep it under a page.")],
    },
  });
  check(
    "a revision carries the document being revised",
    revision.includes("THE CURRENT VERSION") && revision.includes("The list goes stale."),
  );
  check("a revision carries the standing directions", revision.includes("Never propose replacing the CRM"));
  check("a revision carries the recent turns", revision.includes("Keep it under a page."));
  check("a revision is told to revise, not restart", revision.includes("rather than starting over"));
  check(
    "the newest instruction is the last thing asked for",
    revision.lastIndexOf("Cut the second section.") >
      revision.lastIndexOf("Keep it under a page."),
  );
}

// --- Compaction (the pure size-budget split) ---
{
  check("a short thread is not compacted", splitForCompaction([
    turn("a", "human", "short"),
    turn("b", "specialist", "Produced version 1."),
  ]).fold.length === 0);

  const long = [
    turn("old1", "human", "x".repeat(3000)),
    turn("old2", "human", "y".repeat(3000)),
    turn("newest", "human", "Cut the second section."),
  ];
  // 3000 + the newest turn fits inside the budget; the second 3000 does not,
  // so exactly the oldest turn folds. Compaction takes what it must, not more.
  const split = splitForCompaction(long);
  check(
    "an over-budget thread folds its oldest turns",
    split.fold.length === 1 && split.fold[0]!.id === "old1",
    `${split.fold.length} folded`,
  );
  check(
    "the instruction being acted on is never folded",
    split.keep.at(-1)?.id === "newest" && !split.fold.some((entry) => entry.id === "newest"),
  );
  check(
    "what is kept fits the budget",
    split.keep.reduce((total, entry) => total + entry.body.length, 0) <= VERBATIM_BUDGET,
  );

  // A single turn larger than the whole budget is still sent: dropping the
  // only instruction there is would be worse than an oversized prompt.
  const huge = splitForCompaction([turn("huge", "human", "z".repeat(9000))]);
  check("one oversized turn is kept rather than dropped", huge.keep.length === 1 && huge.fold.length === 0);
}

// --- The thread projected straight from run events (no persistence at all) ---
{
  const inline = (value: unknown) => `inline:${JSON.stringify(value)}`;
  const at = (minute: number) => new Date(2024, 0, 1, 0, minute).toISOString();
  const stepCompleted = (seq: number, stepId: string, output: unknown, minute: number) => ({
    seq,
    type: "StepCompleted",
    body: { stepId, attempt: 1, output: { ref: inline(output) }, at: at(minute) },
  });
  const signalReceived = (seq: number, payload: unknown, minute: number) => ({
    seq,
    type: "SignalReceived",
    body: { signalName: "solutions-builder.stage.1.round", signalId: `sig-${seq}`, payload, at: at(minute) },
  });

  const round1 = at(0);
  const iteration1 = {
    runId: "run_anchor__revise-1__0",
    events: [
      signalReceived(1, {
        command: "stage.draft",
        draft: true,
        message: "Focus on cold outbound.",
        quotes: [{ quote: "Reps rebuild the list every Monday." }],
        mode: "final",
      }, 0),
      stepCompleted(2, ROUND_STEP_ID, {
        command: "stage.draft",
        draft: true,
        message: "Focus on cold outbound.",
        quotes: [{ quote: "Reps rebuild the list every Monday." }],
        mode: "final",
      }, 0),
      stepCompleted(
        3,
        DRAFT_STEP_ID,
        { reply: "# In Short\nThis draft nails the process.\n\n# Open Questions\n- Which channel do we use?\n- How many leads per week?\n" },
        1,
      ),
      stepCompleted(4, EVALUATE_STEP_ID, { reply: "Verdict: ready\n- Scope is clear\n- Audience is named" }, 1),
    ],
  };

  const iteration2 = {
    runId: "run_anchor__revise-1__1",
    events: [
      signalReceived(1, { command: "stage.draft", draft: true, message: "Email.", mode: "interview" }, 2),
      stepCompleted(3, DRAFT_STEP_ID, { reply: "# In Short\nRevised per the channel answer.\n" }, 2),
    ],
  };

  const iteration3 = {
    runId: "run_anchor__revise-1__2",
    events: [
      signalReceived(1, { command: "stage.draft", draft: true, message: "", quotes: [], mode: "final" }, 3),
      stepCompleted(3, DRAFT_STEP_ID, { reply: "# In Short\nNothing more to add.\n" }, 3),
    ],
  };

  const nodes = [
    { id: "nod_1", provenance: { stepRef: `${iteration1.runId}/${DRAFT_STEP_ID}` } },
    { id: "nod_2", provenance: { stepRef: `${iteration2.runId}/${DRAFT_STEP_ID}` } },
  ];

  const turns = await projectStageThread({
    iterations: [iteration1 as never, iteration2 as never, iteration3 as never],
    nodes,
    opening: { body: "Reps rebuild the list every Monday.", createdAt: round1 },
  });

  check("the opening problem statement is the first turn", turns[0]?.body === "Reps rebuild the list every Monday.");
  check(
    "a human turn with a quote projects with the quote",
    turns[1]?.role === "human" && turns[1]?.quotes[0]?.quote === "Reps rebuild the list every Monday.",
  );
  check(
    "a final draft with two questions opens a round with the first question",
    turns[2]?.role === "specialist" &&
      turns[2]?.questions?.length === 2 &&
      turns[2]!.body.includes("Which channel do we use?"),
    turns[2]?.body,
  );
  check("the draft's result node rides on its turn", turns[2]?.resultNodeId === "nod_1");

  check(
    "an interview-mode iteration projects the next question, not its own draft's questions",
    turns[4]?.role === "specialist" && turns[4]?.questions === null && turns[4]?.body === "How many leads per week?",
    turns[4]?.body,
  );
  check("its result node still rides on the turn", turns[4]?.resultNodeId === "nod_2");

  check(
    "an empty message with no quotes projects no human turn",
    turns.filter((entry) => entry.id === `${iteration3.runId}:round`).length === 0,
  );

  const evaluation = await evaluationIn([iteration1 as never, iteration2 as never, iteration3 as never]);
  check(
    "the evaluation parses the latest verdict",
    evaluation?.ready === true && evaluation.notes.length === 2,
    JSON.stringify(evaluation),
  );

  // Stage 6 is two rounds: the requirements, with the plan's step skipped by
  // its gate, then the plan with the requirements' step skipped. The event
  // shapes are the runtime's own, read off a real run: a skipped step
  // completes with a sentinel and no reply.
  const skipped = (seq: number, stepId: string, minute: number) =>
    stepCompleted(seq, stepId, { skipped: true, gateId: "pick-1", branch: stepId }, minute);
  const requirementsRound = {
    runId: "run_anchor__revise-6__0",
    events: [
      signalReceived(1, { command: "stage.draft", draft: true, message: "Keep it to one binary.", mode: "final", wanted: [true, false] }, 10),
      stepCompleted(2, ROUND_STEP_ID, { command: "stage.draft", draft: true, message: "Keep it to one binary.", mode: "final", wanted: [true, false] }, 10),
      stepCompleted(3, REQUIREMENTS_STEP_ID, { reply: "## In short\n- **One binary.**\n\n## Purpose\nTriage.\n" }, 11),
      skipped(4, DRAFT_STEP_ID, 11),
      skipped(5, "review-application", 11),
    ],
  };
  const planRound = {
    runId: "run_anchor__revise-6__1",
    events: [
      signalReceived(1, { command: "stage.draft", draft: true, message: "", mode: "final", wanted: [false, true] }, 12),
      stepCompleted(2, ROUND_STEP_ID, { command: "stage.draft", draft: true, message: "", mode: "final", wanted: [false, true] }, 12),
      stepCompleted(3, REQUIREMENTS_STEP_ID, { skipped: true, gateId: "pick-0", branch: REQUIREMENTS_STEP_ID }, 12),
      stepCompleted(4, DRAFT_STEP_ID, { reply: "## In short\n- **Two services.**\n\n## What I need from you\nWhich licence?\n- Option: MIT\n" }, 13),
      stepCompleted(5, "review-application", { reply: "## Verdict\nacceptable\n" }, 13),
    ],
  };
  const planTurns = await projectStageThread({
    iterations: [requirementsRound as never, planRound as never],
    nodes: [
      { id: "nod_req", provenance: { stepRef: `${requirementsRound.runId}/${REQUIREMENTS_STEP_ID}` } },
      { id: "nod_plan", provenance: { stepRef: `${planRound.runId}/${DRAFT_STEP_ID}` } },
    ],
  });
  check(
    "the requirements round projects the person's message and one requirements turn, no plan turn",
    planTurns.length === 3 && planTurns[0]?.role === "human" && planTurns[1]?.resultNodeId === "nod_req" && planTurns[1]?.questions === null,
    planTurns.map((entry) => `${entry.role}:${entry.resultNodeId}`).join(" "),
  );
  check(
    "the plan round projects the architect's turn with its question, and no turn for the skipped requirements",
    planTurns[2]?.resultNodeId === "nod_plan" && planTurns[2]?.questions?.[0]?.startsWith("Which licence?") === true,
    planTurns[2]?.body,
  );
}

// From here on the embedded hub has to be mounted and installed: the command
// ledger a project's opening problem statement rides on, and the artifact
// store a version's `provenance.brief` is read back from, are both platform
// writes.
const dataDir = await mkdtemp(join(tmpdir(), "sb-convo-"));
await prepareDatabase(await openDatabase(`${dataDir}/pglite`));
await mountHub();
await install();

const ACTOR = localActor();

const POLICY = {
  costTolerancePercent: 15,
  costToleranceAbsolute: 500,
  audiences: [{ name: "Project owner", role: "project_owner" as const }],
  audienceQuorum: 1,
  allowExternalProviders: false,
};

// --- The standing brief rides on the version, not a separate marker turn ---
{
  const project = await createProject({
    title: "Outreach",
    policy: POLICY,
    owner: { ...ACTOR, displayName: "Local" },
  });

  check(
    "nothing is pending and there is no brief before any version exists",
    (await pendingContext(project.projectId, 1)).brief === null,
  );

  const written = await writeArtifact(
    {
      projectId: project.projectId,
      kind: agentFor(1).produces!,
      title: "Problem brief — stage 1",
      content: "# Problem brief\n\nSample content.",
      mediaType: "text/markdown",
      sourceVersionIds: [],
      provenance: { producer: "agent", brief: "- Keep it short.\n- Never propose replacing the CRM." },
    },
    ACTOR,
  );

  const context = await pendingContext(project.projectId, 1);
  check(
    "the standing brief is read off the latest version's own provenance",
    context.brief === "- Keep it short.\n- Never propose replacing the CRM.",
  );
  check(
    "nothing is pending before any round has run against that version",
    context.pending.length === 0,
  );
  void written;
}

// What somebody types when they open a project is the first thing they said,
// and it has to survive. It rides on the `project.create` command itself now
// — recorded once, read back as stage 1's opening turn — rather than a
// separate append that used to be accepted and dropped.
{
  const { titleFromProblem } = await import("../apps/hub/src/title.js");
  const problem = "Cold outbound is rebuilt by hand every Monday and it eats my week.";
  const opened = await createProject({
    title: titleFromProblem(problem),
    policy: { ...POLICY, audiences: [], audienceQuorum: 0 },
    owner: { ...ACTOR, displayName: "You" },
    problemStatement: problem,
  });

  const opening = await threadTurns(opened.projectId, 1);
  check(
    "the problem someone opened with is the first turn on stage 1",
    opening.length === 1 && opening[0]!.body === problem && opening[0]!.role === "human",
    opening.map((entry) => `${entry.role}:${entry.body.slice(0, 24)}`).join(" | "),
  );
  check(
    "a long opening line is trimmed to a title rather than used whole",
    titleFromProblem("a".repeat(200)).length <= 60,
    String(titleFromProblem("a".repeat(200)).length),
  );
  check(
    "and a short one is left alone",
    titleFromProblem("Cold outreach agent") === "Cold outreach agent",
  );
}

console.log(`\nConversation smoke: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) process.exit(1);
