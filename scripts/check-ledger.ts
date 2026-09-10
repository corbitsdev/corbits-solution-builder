/**
 * Ledger integrity — BUILD_PLAN_V3 section 7.
 *
 * The ledger is meant to be the single machine-readable contract, so it has to
 * be internally consistent before anything consumes it. This checks the claims
 * the plan makes about it, and it is deliberately picky: a ledger that silently
 * disagrees with itself is worse than no ledger, because the guard would still
 * look authoritative.
 */
import {
  BUILD_STATES,
  COMMANDS,
  FORBIDDEN,
  LEDGER,
  STAGES,
  STAGE_STATES,
  TERMINAL_STATES,
  isTerminal,
} from "@solutions-builder/app/ledger";

const problems: string[] = [];
const seen = new Set<string>();

/** Commands whose effect is on the project, not on the run's own state. */
const PROJECT_LEVEL: string[] = ["project.archive", "project.delete"];

/**
 * `failed` and `cancelled` deliberately name states of both run kinds. That is
 * unambiguous only because the guard filters on kind before state, so the real
 * property to check is that no (command, kind, state) triple has two rows.
 */
const routes = new Map<string, string>();

for (const row of LEDGER) {
  if (seen.has(row.id)) problems.push(`Duplicate transition id: ${row.id}`);
  seen.add(row.id);

  if (!(COMMANDS as readonly string[]).includes(row.command)) {
    problems.push(`${row.id}: unknown command ${row.command}`);
  }

  for (const side of ["from", "to"] as const) {
    const end = row[side];
    if (!end) continue;
    const states = end.kind === "stage" ? STAGE_STATES : BUILD_STATES;
    if (!(states as readonly string[]).includes(end.state)) {
      problems.push(`${row.id}: ${side} state ${end.state} is not a ${end.kind} state`);
    }
  }

  // A run's own terminal state can only be left by creating a *new* run,
  // never by moving the terminal one. `project.archive` is exempt: it changes
  // a project flag, not the state of the delivered run.
  if (row.from && isTerminal(row.from.state) && row.createsRun === null) {
    if (!PROJECT_LEVEL.includes(row.command)) {
      problems.push(
        `${row.id}: leaves terminal state ${row.from.state} without creating a new run`,
      );
    }
  }

  if (row.stages) {
    for (const stage of row.stages) {
      if (!(STAGES as readonly number[]).includes(stage)) {
        problems.push(`${row.id}: stage ${stage} is out of range`);
      }
    }
  }

  if (row.from) {
    const route = `${row.command}|${row.from.kind}|${row.from.state}`;
    const previous = routes.get(route);
    if (previous) {
      problems.push(`${row.id} and ${previous} both claim ${route}; routing is ambiguous`);
    }
    routes.set(route, row.id);
  }

  if (row.authority.length === 0) problems.push(`${row.id}: no authority named`);
  if (row.preconditions.length === 0) problems.push(`${row.id}: no preconditions recorded`);
  if (row.effects.length === 0) problems.push(`${row.id}: no durable effect recorded`);
}

// Every command in the vocabulary is either a ledger row or explicitly outside
// it. A command with neither is a route no rule covers.
const OUTSIDE_LEDGER = ["project.delete"];
for (const command of COMMANDS) {
  const covered = LEDGER.some((row) => row.command === command);
  if (!covered && !OUTSIDE_LEDGER.includes(command)) {
    problems.push(`Command ${command} has no ledger row and is not declared outside it`);
  }
}

// The freeze interlock, checked as a property rather than trusted as prose.
const freeze = LEDGER.filter((row) => row.command === "build.freeze");
if (freeze.length !== 1) {
  problems.push(`build.freeze must have exactly one row; found ${freeze.length}`);
} else if (freeze[0]!.from?.state !== "cost_approved") {
  problems.push("build.freeze must start from cost_approved, not from waiting_approval");
}
if (!FORBIDDEN.some((entry) => entry.command === "build.freeze")) {
  problems.push("Re-freeze must be recorded as forbidden");
}

// stage.approve must not cover stage 7; that is the cost-approval interlock.
const approve = LEDGER.find((row) => row.id === "stage.approve");
if ((approve?.stages as readonly number[] | null)?.includes(7)) {
  problems.push("stage.approve must not apply at stage 7");
}

// audience.decide records; it never transitions.
const audience = LEDGER.find((row) => row.id === "audience.decide");
if (audience?.to !== null) problems.push("audience.decide must not have a target state");

// cost.approve does not advance a stage.
const cost = LEDGER.find((row) => row.command === "cost.approve");
if (cost?.to?.state !== "cost_approved") {
  problems.push("cost.approve must land on cost_approved without advancing a stage");
}

// Archiving is delivered-only, so nothing in flight silently disappears.
const archive = LEDGER.find((row) => row.command === "project.archive");
if (archive?.from?.state !== "delivered") {
  problems.push("project.archive must only apply to a delivered project");
}

// build.answer resumes the same attempt: it creates no run.
const answer = LEDGER.find((row) => row.command === "build.answer");
if (answer?.createsRun !== null) {
  problems.push("build.answer must never create a run");
}

// Every terminal state must actually be reachable, or it is dead vocabulary
// that a reader would mistake for a real state of the product.
for (const terminal of TERMINAL_STATES) {
  // `approved_frozen` and `evidence_accepted` are set as a side effect of
  // build.freeze and build.accept_evidence, whose `to` names the run they
  // create. `archived` and `deleted` are project-level, reached by the two
  // PROJECT_LEVEL commands rather than by a run transition.
  const sideEffectTerminals = ["approved_frozen", "evidence_accepted", "archived", "deleted"];
  const reachable =
    LEDGER.some((row) => row.to?.state === terminal) || sideEffectTerminals.includes(terminal);
  if (!reachable) problems.push(`Terminal state ${terminal} is never reached by any transition`);
}

// The native Interchange workflow is generated from this ledger, so the two
// cannot disagree by construction — but a generator can still drop something.
// These assert the properties that matter if it ever does.
{
  const { projectLifecycleDefinition, commandsAtStage, stageStepId } = await import(
    "@solutions-builder/app/workflows/project-lifecycle"
  );
  const definition = projectLifecycleDefinition();

  for (const stage of STAGES) {
    if (!definition.stepOrder.includes(stageStepId(stage))) {
      problems.push(`The native workflow has no step for stage ${stage}`);
    }
  }
  if (definition.stepOrder.length !== STAGES.length) {
    problems.push(
      `The native workflow has ${definition.stepOrder.length} steps for ${STAGES.length} stages`,
    );
  }

  // Every stage still ends at a human gate, and the check follows the child
  // workflow to prove it rather than trusting the shape of the parent. A stage
  // that could complete without a person is an automatic advancement, which
  // section 7 forbids outright; hiding one inside a child would be the easiest
  // way to lose that guarantee.
  for (const [id, primitive] of Object.entries(definition.steps)) {
    const step = primitive as {
      kind?: string;
      definition?: { inline?: { steps?: Record<string, { kind?: string; after?: string[] }> } };
    };
    if (step.kind === "awaitSignal") continue;
    if (step.kind !== "childWorkflow") {
      problems.push(`Workflow step ${id} is neither a gate nor a stage workflow`);
      continue;
    }
    const inner = step.definition?.inline?.steps ?? {};
    const gates = Object.entries(inner).filter(([, child]) => child.kind === "awaitSignal");
    if (gates.length === 0) {
      problems.push(`Stage workflow ${id} contains no human gate`);
    }
    // And the loop inside it must be bounded: an unbounded revise loop is a
    // way to spend somebody's money until they notice.
    for (const [childId, child] of Object.entries(inner)) {
      if (child.kind !== "loop") continue;
      const bound = (child as { maxIterations?: number }).maxIterations;
      if (typeof bound !== "number" || bound <= 0) {
        problems.push(`Loop ${id}.${childId} is not bounded`);
      }
    }
  }

  // The stage-7 interlock has to survive into the native definition: cost
  // approval, not stage approval, is what leaves that gate.
  if (commandsAtStage(7).includes("stage.approve")) {
    problems.push("The native workflow offers stage.approve at stage 7");
  }
  if (!commandsAtStage(7).includes("cost.approve")) {
    problems.push("The native workflow does not offer cost.approve at stage 7");
  }

  // Projects start when a person starts one.
  if (!definition.triggers.some((trigger) => (trigger as { type?: string }).type === "manual")) {
    problems.push("The native workflow is not manually triggered");
  }
}

if (problems.length > 0) {
  console.error("Ledger problems:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Ledger is consistent: ${LEDGER.length} transitions, ${COMMANDS.length} commands, ` +
    `${FORBIDDEN.length} forbidden cases, and the native Interchange workflow ` +
    `generated from it agrees.`,
);
