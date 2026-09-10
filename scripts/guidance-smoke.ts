/**
 * "What do I do now?" must never be a question this product leaves unanswered.
 *
 * Every state a run can reach — including the endings — has to resolve to a
 * named next move on a named surface. This is checked exhaustively against the
 * ledger's own state list rather than a copy of it, so adding a state to the
 * ledger and forgetting to guide it fails here.
 */
import { BUILD_STATES, STAGE_STATES, type RunState } from "@solutions-builder/app/ledger";
import { activityHeadline, nextStep } from "@solutions-builder/app/next-step";
import { deterministicGuidance } from "../apps/hub/src/guide.js";
import { AGENT_KIT, panelPrincipals } from "@solutions-builder/app/kit";
import { assumptionsIn, questionIn, questionsIn, summaryIn } from "@solutions-builder/app/document";

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

const ALL: RunState[] = [...new Set<RunState>([...STAGE_STATES, ...BUILD_STATES])];

for (const state of ALL) {
  const step = nextStep({ state, stage: 1, hasDraft: true });
  check(
    `${state} tells you what happens next`,
    step.title.trim().length > 0 && step.detail.trim().length > 0,
    step.title,
  );
}

check(
  "a project that does not exist yet still guides",
  nextStep({ state: null, stage: 1, hasDraft: false }).title.length > 0,
);

// The two moments inside one state are genuinely different jobs, and saying
// "draft this stage" to someone staring at a draft is how a guided product
// stops feeling guided.
{
  const empty = nextStep({ state: "in_progress", stage: 1, hasDraft: false });
  const drafted = nextStep({ state: "in_progress", stage: 1, hasDraft: true });
  check("before a draft, you are asked for the problem", empty.title !== drafted.title, empty.title);
  check(
    "after a draft, with a real second approver, you are asked to send it on",
    drafted.title === "Send for approval",
    drafted.title,
  );
}

// A solo approver never sees "submit to yourself" — one action, worded as an
// approval, not a handoff. Falsified below by checking the wording actually
// changes with the flag.
{
  const soloDraft = nextStep({ state: "in_progress", stage: 2, hasDraft: true, soloApproval: true });
  const notSoloDraft = nextStep({ state: "in_progress", stage: 2, hasDraft: true, soloApproval: false });
  check("a solo approver is told to approve, not submit", soloDraft.title === "Approve and continue", soloDraft.title);
  check(
    "a solo approver never sees the word Submit",
    !soloDraft.title.toLowerCase().includes("submit"),
    soloDraft.title,
  );
  check(
    "a non-solo approver still sees the send-on wording",
    notSoloDraft.title === "Send for approval",
    notSoloDraft.title,
  );
  check(
    "stage 7's solo wording names the cost, not a generic approval",
    nextStep({ state: "in_progress", stage: 7, hasDraft: true, soloApproval: true }).title === "Approve the cost",
  );
  check(
    "waiting_approval is worded for the approver",
    nextStep({ state: "waiting_approval", stage: 1, hasDraft: true }).title === "Approve or send back",
  );
}

// Stage 5 is gated on a quorum, so its guidance has to count.
{
  const partial = nextStep({
    state: "in_progress",
    stage: 5,
    hasDraft: true,
    quorum: { recorded: 1, needed: 3, blocked: 0 },
  });
  check("an unmet quorum says how many are left", partial.title.includes("2 more"), partial.title);

  const blocked = nextStep({
    state: "in_progress",
    stage: 5,
    hasDraft: true,
    quorum: { recorded: 2, needed: 3, blocked: 1 },
  });
  check("a blocking decision outranks the count", blocked.title.includes("blocking"), blocked.title);

  const met = nextStep({
    state: "in_progress",
    stage: 5,
    hasDraft: true,
    quorum: { recorded: 3, needed: 3, blocked: 0 },
  });
  check("a met quorum moves you on", met.title.includes("Submit"), met.title);
}

// An ending is not an instruction. Telling someone to act when there is
// nothing left to do is the same failure in the other direction.
{
  const endings: RunState[] = ["delivered", "cancelled", "archived", "deleted"];
  check(
    "endings are marked as endings",
    endings.every((state) => nextStep({ state, stage: 9, hasDraft: true }).ending === true),
  );
  check(
    "waiting states are not marked as endings",
    !nextStep({ state: "waiting_approval", stage: 1, hasDraft: true }).ending,
  );
}

// --- "What is happening right now", derived from the runtime's own step ---
{
  const parkedAtGate = activityHeadline({
    state: "waiting_approval",
    stage: 1,
    parked: true,
    hasDraft: true,
  });
  check(
    "a project parked at the gate reports the approval phrasing",
    parkedAtGate === "Waiting for your approval",
    parkedAtGate,
  );

  const midLoop = activityHeadline({ state: "in_progress", stage: 1, parked: false, hasDraft: false });
  check(
    "a project mid-loop does not report the approval phrasing",
    midLoop !== "Waiting for your approval",
    midLoop,
  );
  check("a project mid-loop with no draft yet is drafting", midLoop === "Drafting", midLoop);

  const revising = activityHeadline({ state: "in_progress", stage: 1, parked: true, hasDraft: true });
  check("a project with a draft, parked, is revising", revising === "Revising the draft", revising);

  const stage7 = activityHeadline({ state: "waiting_approval", stage: 7, parked: true, hasDraft: true });
  check("stage 7 names the cost, not a generic approval", stage7 === "Waiting for you to approve the cost", stage7);

  const audienceLeft = activityHeadline({
    state: "waiting_approval",
    stage: 5,
    parked: true,
    hasDraft: true,
    quorum: { recorded: 1, needed: 3, blocked: 0 },
  });
  check(
    "stage 5 counts down the remaining audience decisions",
    audienceLeft === "Waiting on 2 more audience decisions",
    audienceLeft,
  );
  check(
    "no enum value or step id ever reaches the headline",
    ![parkedAtGate, midLoop, revising, stage7, audienceLeft].some(
      (headline) => /awaitSignal|stepId|signalName|in_progress|waiting_approval/i.test(headline),
    ),
  );
}

// --- The Product guide's deterministic floor (BUILD_PLAN_V3 section 8) ---
{
  const floor = deterministicGuidance({
    projectTitle: "Outreach",
    stage: 1,
    state: "in_progress",
    versions: [],
    approvals: [],
  });
  check("the floor always names a recommendation", floor.recommended.length > 0, floor.recommended);
  check("the floor says it is the floor", floor.origin === "deterministic");
  check("the floor always offers at least one option", floor.options.length >= 1);
  check(
    "an empty stage reports what is missing",
    floor.missing.length === 2 && floor.readiness === "not_ready",
    floor.missing.join(" | "),
  );
  check(
    "the guide recommends the same move the bar shows",
    floor.recommended === nextStep({ state: "in_progress", stage: 1, hasDraft: false }).title,
  );
}

// The specialist's question is the next turn of the conversation, so it has to
// come out of the draft intact — and stay out when there is nothing to ask.
{
  const brief = [
    "## In short",
    "- The list is rebuilt by hand every Monday, in **one place** nobody trusts.",
    "- A fix has to keep the **reason** a name was chosen.",
    "",
    "## Problem statement",
    "Reps rebuild the list every Monday.",
    "",
    "## What I need from you",
    "- Should the agent send messages on its own, or draft them for your review?",
    "- Which channel — email, LinkedIn, both?",
    "",
    "## What I assumed",
    "- Email is the channel",
    "- Outbound means sales pipeline",
  ].join("\n");
  const digest = summaryIn(brief);
  check("the digest is lifted out of the draft", digest?.includes("**one place**") === true, String(digest));
  check("the digest stops at the next heading", digest?.includes("Problem statement") === false);
  check("a draft without a digest has none", summaryIn("## Problem statement\nx") === null);

  const assumed = assumptionsIn(brief);
  check("assumptions are lifted out of the draft", assumed.length === 2, assumed.join(" | "));
  check("a draft that assumed nothing records none", assumptionsIn("## What I assumed\n- None") .length === 0);

  const all = questionsIn(brief);
  check("every question is lifted out of the draft", all.length === 2, `${all.length} found`);
  check("they keep the order they were asked in", all[0]?.startsWith("Should the agent send") === true);
  check("the next heading ends the section", !all.some((entry) => entry.includes("Email is the channel")));
  check("a draft without a question asks nothing", questionIn("## Problem statement\nx") === null);
  check(
    "a section that says nothing asks nothing",
    questionIn("## What I need from you\n- Nothing — correct anything above that is wrong.") === null,
  );
  check("an older open-questions heading still works", questionIn("## Open questions for the user\n- How many reps?") === "How many reps?");
}

// --- The panel is four principals, not one voice (sections 4 and 8) ---
{
  const panel = panelPrincipals();
  check("the panel has four principals", panel.length === 4, panel.map((p) => p.id).join(", "));
  check(
    "each principal has its own prompt key",
    new Set(panel.map((entry) => entry.promptKey)).size === 4,
  );
  check(
    "each principal has its own curated model binding",
    new Set(panel.map((entry) => entry.modelKey)).size === 4,
  );
  check(
    "the prompt keys are the stable seed keys section 8 names",
    panel.every((entry) => /^sb-prompt-engineering-(application|quality|platform|security)-v1$/.test(entry.promptKey)),
  );
  check(
    "no principal may approve, waive or grant",
    panel.every((entry) => /never|not/i.test(entry.boundary)),
  );
  // The failure this replaces: one agent told to hold four opinions.
  check(
    "no single synthetic reviewer remains in the kit",
    !AGENT_KIT.some((entry) => entry.id === "senior-engineer-panel"),
  );
}

console.log(`\nGuidance smoke: ${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) process.exit(1);
