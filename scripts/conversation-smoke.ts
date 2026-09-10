/**
 * The stage conversation, on Interchange's native session and mail, and its
 * compactor.
 *
 * Three claims are load-bearing and none of them are obvious from reading the
 * code, so they are checked here: that a revision carries the document it is
 * revising, that compaction never drops the instruction being acted on, and
 * that a brief and the turns it covers commit together — now expressed as an
 * `agent_session`'s `session_mail` / `turn_part` rows rather than the retired
 * `stage_message` / `stage_brief` tables.
 */
import { buildDraftPrompt } from "../apps/hub/agent-run.js";
import {
  VERBATIM_BUDGET,
  splitForCompaction,
} from "../apps/hub/agent-conversation.js";
import {
  appendHumanTurn,
  appendSpecialistTurn,
  pendingContext,
  recordBrief,
  threadTurns,
  sessionIdFor,
  type StageTurn,
} from "../apps/hub/hub-conversation.js";
import { nextQuestion } from "../apps/hub/questions.js";
import { openDatabase } from "../apps/hub/db.js";
import { prepareDatabase } from "../apps/hub/migrate.js";
import { mountHub } from "../apps/hub/hub-mount.js";
import { createProject } from "../apps/hub/projects.js";
import { install } from "../apps/hub/install.js";
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

// Everything from here on writes to `agent_session` / `session_mail` /
// `turn_part`, so the embedded hub has to be mounted and its stage workflow
// definitions seeded — the definition an `agent_session` is keyed to.
const dataDir = await mkdtemp(join(tmpdir(), "sb-convo-"));
await prepareDatabase(await openDatabase(`${dataDir}/pglite`));
await mountHub();
await install();

const ACTOR = { principalId: "p_owner" };

// --- Persistence, on session_mail / turn_part ---
{
  const project = await createProject({
    title: "Outreach",
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 500,
      audiences: [{ name: "Project owner", role: "project_owner" }],
      audienceQuorum: 1,
      allowExternalProviders: false,
    },
    owner: { principalId: "p_owner", displayName: "Local" },
  });

  const key = {
    projectId: project.projectId,
    branchId: project.branchId,
    runId: project.runId,
    stage: 1,
  };
  const one = await appendHumanTurn({
    ...key,
    body: "Keep it short.",
    actor: ACTOR,
    quotes: [{ quote: "a passage" }],
  });
  await appendSpecialistTurn({ ...key, body: "Produced version 1.", actor: ACTOR, resultNodeId: "nod_x" });
  const two = await appendHumanTurn({ ...key, body: "Cut section two.", actor: ACTOR });

  const all = await threadTurns(key.projectId, key.branchId, 1);
  check("turns persist in order", all.length === 3 && all[0]!.id === one && all[2]!.id === two);
  check("an attached passage is retained", all[0]!.quotes[0]?.quote === "a passage");

  check(
    "nothing is compacted until it is",
    (await pendingContext(key.projectId, key.branchId, 1)).pending.length === 3,
  );

  // Compaction always folds a chronological prefix — `splitForCompaction`
  // never produces anything else — so a brief written now covers every turn
  // written before it, and only a turn written after stays pending.
  await recordBrief({
    projectId: key.projectId,
    branchId: key.branchId,
    stage: 1,
    runId: key.runId,
    body: "- Keep it short.",
    actor: ACTOR,
  });
  const coveredContext = await pendingContext(key.projectId, key.branchId, 1);
  check("a covered turn stops being sent", coveredContext.pending.length === 0);
  check("the brief is readable back", coveredContext.brief === "- Keep it short.");

  const three = await appendHumanTurn({ ...key, body: "One more thing.", actor: ACTOR });
  const afterMore = await pendingContext(key.projectId, key.branchId, 1);
  check(
    "uncovered turns are still sent",
    afterMore.pending.length === 1 && afterMore.pending[0]!.id === three,
  );
  check(
    "compaction never deletes what the person wrote",
    (await threadTurns(key.projectId, key.branchId, 1)).length === 4,
  );
}

// --- The interview: one question at a time ---
{
  const project = await createProject({
    title: "Outreach",
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 500,
      audiences: [{ name: "Project owner", role: "project_owner" }],
      audienceQuorum: 1,
      allowExternalProviders: false,
    },
    owner: { principalId: "p_owner", displayName: "Local" },
  });
  const key = {
    projectId: project.projectId,
    branchId: project.branchId,
    stage: 1,
    runId: project.runId,
  };

  const asked = ["Which channel?", "Send or draft?", "How many leads?"];
  // The round opens on the specialist's own turn: the questions ride on the
  // mail, and which one is open is read back from the thread.
  await appendSpecialistTurn({ ...key, body: asked[0]!, actor: ACTOR, questions: asked });

  let open = await nextQuestion(key.projectId, key.branchId, 1);
  check("the first question is asked first", open?.body === "Which channel?", String(open?.body));
  check("it knows how many follow", open?.remaining === 2, `${open?.remaining} remaining`);

  const answer = await appendHumanTurn({ ...key, body: "Email.", actor: ACTOR });

  open = await nextQuestion(key.projectId, key.branchId, 1);
  check("answering asks the next one", open?.body === "Send or draft?", String(open?.body));
  check("the count comes down", open?.remaining === 1, `${open?.remaining} remaining`);
  check("the follow-up question is a turn that does not reopen the round", (await (async () => {
    await appendSpecialistTurn({ ...key, body: open!.body, actor: ACTOR });
    return (await nextQuestion(key.projectId, key.branchId, 1))?.ordinal;
  })()) === 1);

  // Choosing to move on redrafts, and the new draft opens a new round: that is
  // what retires what was left of the old one.
  await appendSpecialistTurn({ ...key, body: "Here is the revised draft.", actor: ACTOR, questions: [] });
  check(
    "moving on retires what is left",
    (await nextQuestion(key.projectId, key.branchId, 1)) === null,
  );
  check(
    "an answered question is not retired with them",
    (await threadTurns(key.projectId, key.branchId, 1)).some((t) => t.id === answer),
  );

  // A new draft's questions replace an older draft's unanswered ones: a
  // question about superseded text is not worth asking.
  await appendSpecialistTurn({ ...key, body: "Stale?", actor: ACTOR, questions: ["Stale?"] });
  await appendSpecialistTurn({ ...key, body: "Fresh?", actor: ACTOR, questions: ["Fresh?"] });
  check(
    "a new draft supersedes the old draft's questions",
    (await nextQuestion(key.projectId, key.branchId, 1))?.body === "Fresh?",
  );
}

// Ordering, written fast enough that a clock alone cannot separate the turns.
// The thread is the product's main surface: an answer rendered above the
// question it answers is the one fault a reader cannot look past.
{
  const ordering = await createProject({
    title: "Ordering",
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
    owner: { ...ACTOR, displayName: "You" },
  });
  const key = {
    projectId: ordering.projectId,
    branchId: ordering.branchId,
    stage: 3 as const,
    runId: "run_order",
  };
  const bodies = ["first", "second", "third", "fourth", "fifth", "sixth"];
  for (const [index, body] of bodies.entries()) {
    if (index % 2 === 0) {
      await appendHumanTurn({ ...key, body, actor: ACTOR });
    } else {
      await appendSpecialistTurn({ ...key, body, actor: ACTOR });
    }
  }
  const ordered = await threadTurns(key.projectId, key.branchId, key.stage);

  // The timestamps alone happen to separate these writes, so asserting the
  // rendered order proves nothing about the tiebreak. The stored positions are
  // what the fix actually changed: assert those directly, so forcing them back
  // to a constant fails this gate.
  {
    const { turnPart } = await import("@intx/db/schema");
    const { hub } = await import("../apps/hub/hub-mount.js");
    const { eq } = await import("drizzle-orm");
    const rows = (await (hub().db.db as never as {
      select: () => { from: (t: unknown) => { where: (p: unknown) => Promise<unknown[]> } };
    })
      .select()
      .from(turnPart)
      .where(
        eq(
          (turnPart as never as { sessionId: never }).sessionId,
          await sessionIdFor(key.projectId, key.branchId, key.stage),
        ),
      )) as {
      ordinal: number | null;
    }[];
    const positions = rows.map((row) => row.ordinal ?? 0).sort((a, b) => a - b);
    check(
      "every turn on a thread carries a distinct position, not a constant",
      positions.length === bodies.length &&
        new Set(positions).size === positions.length,
      positions.join(","),
    );
  }
  const seen = ordered.map((turn) => turn.body);
  check(
    "turns written in the same instant still read back in the order they were written",
    JSON.stringify(seen) === JSON.stringify(bodies),
    seen.join(" | "),
  );
  check(
    "and the roles alternate as they were written",
    ordered.every((turn, index) => turn.role === (index % 2 === 0 ? "human" : "specialist")),
    ordered.map((turn) => turn.role).join(","),
  );
}


// What somebody types when they open a project is the first thing they said,
// and it has to survive. It used to be accepted by `createProject` and written
// nowhere — so stage 1 opened by asking for the problem they had just
// described, and the words themselves were gone.
{
  const { titleFromProblem } = await import("../apps/hub/title.js");
  const problem = "Cold outbound is rebuilt by hand every Monday and it eats my week.";
  const opened = await createProject({
    title: titleFromProblem(problem),
    policy: {
      costTolerancePercent: 15,
      costToleranceAbsolute: 100,
      audiences: [],
      audienceQuorum: 0,
      allowExternalProviders: false,
    },
    owner: { ...ACTOR, displayName: "You" },
  });
  await appendHumanTurn({
    projectId: opened.projectId,
    branchId: opened.branchId,
    runId: opened.runId,
    stage: 1,
    body: problem,
    actor: ACTOR,
  });

  const opening = await threadTurns(opened.projectId, opened.branchId, 1);
  check(
    "the problem someone opened with is the first turn on stage 1",
    opening.length === 1 && opening[0]!.body === problem && opening[0]!.role === "human",
    opening.map((turn) => `${turn.role}:${turn.body.slice(0, 24)}`).join(" | "),
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
