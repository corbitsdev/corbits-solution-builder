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
  const {
    reviseStepId,
    exhaustedStepId,
    roundSignal,
    approveSignal,
    exhaustedSignal,
    loopExits,
    stageSignal,
    continuingCommands,
    ROUND_STEP_ID,
  } = await import("@solutions-builder/app/workflows/stage-loop");
  // stage.draft is the round command that keeps a stage open: it must be a
  // continuing command everywhere, and land on the round signal at every stage.
  if (!continuingCommands().includes("stage.draft")) {
    problems.push("continuingCommands() does not include stage.draft");
  }
  for (const stage of STAGES) {
    if (stageSignal(stage, "stage.draft").name !== roundSignal(stage)) {
      problems.push(`stage.draft does not land on the round signal at stage ${stage}`);
    }
  }

  const definition = projectLifecycleDefinition();
  const steps = definition.steps as Record<
    string,
    {
      kind?: string;
      name?: string;
      maxIterations?: number;
      onExhausted?: string;
      after?: string[];
      body?: { steps?: Record<string, { kind?: string; name?: string }>; stepOrder?: string[] };
    }
  >;

  // Every stage is a bounded revise loop followed by a human gate, both on the
  // top-level run so the hub can signal them. A stage that could complete
  // without a person is an automatic advancement, which section 7 forbids.
  for (const stage of STAGES) {
    const revise = steps[reviseStepId(stage)];
    const gate = steps[stageStepId(stage)];
    if (!revise || revise.kind !== "loop") {
      problems.push(`The native workflow has no revise loop for stage ${stage}`);
      continue;
    }
    if (typeof revise.maxIterations !== "number" || revise.maxIterations <= 0) {
      problems.push(`Loop ${reviseStepId(stage)} is not bounded`);
    }
    if (revise.onExhausted !== exhaustedStepId(stage)) {
      problems.push(`Loop ${reviseStepId(stage)} does not route to a gate when exhausted`);
    }
    const exhausted = steps[exhaustedStepId(stage)];
    if (!exhausted || exhausted.kind !== "awaitSignal" || exhausted.name !== exhaustedSignal(stage)) {
      problems.push(`Stage ${stage}'s exhaustion does not end at a human gate`);
    }
    // The round is the one thing every iteration always has, even once a
    // drafting round grows a gate and agent steps after it: it must be the
    // only awaitSignal in the body, and it must run first — nothing else can
    // be there to receive the signal before it does.
    const iterationSteps = revise.body?.steps ?? {};
    const awaitSignals = Object.entries(iterationSteps).filter(([, step]) => step.kind === "awaitSignal");
    if (
      awaitSignals.length !== 1 ||
      awaitSignals[0]?.[0] !== ROUND_STEP_ID ||
      awaitSignals[0]?.[1].name !== roundSignal(stage)
    ) {
      problems.push(`Stage ${stage}'s iteration's round is not its only awaitSignal`);
    }
    const iterationOrder = revise.body?.stepOrder;
    if (iterationOrder && iterationOrder[0] !== ROUND_STEP_ID) {
      problems.push(`Stage ${stage}'s round does not come first in its iteration`);
    }
    if (!gate || gate.kind !== "awaitSignal" || gate.name !== approveSignal(stage)) {
      problems.push(`The native workflow has no human gate for stage ${stage}`);
    } else if (!gate.after?.includes(reviseStepId(stage))) {
      problems.push(`Stage ${stage}'s gate does not follow its revise loop`);
    }
    // Every command the ledger allows out of the stage lands on one of its two
    // signals, so the run can never be asked for something it cannot consume.
    for (const command of loopExits(stage)) {
      if (stageSignal(stage, command).name !== roundSignal(stage)) {
        problems.push(`${command} leaves in_progress but is not a round signal at stage ${stage}`);
      }
    }
    for (const command of commandsAtStage(stage)) {
      const { name } = stageSignal(stage, command);
      if (name !== roundSignal(stage) && name !== approveSignal(stage)) {
        problems.push(`${command} has no signal on stage ${stage}'s run`);
      }
    }
  }
  if (definition.stepOrder.length !== STAGES.length * 3) {
    problems.push(
      `The native workflow has ${definition.stepOrder.length} steps for ${STAGES.length} stages`,
    );
  }

  // The deployed package is source, not this object: an entry module the
  // probe sidecar evaluates. Evaluate it here against the workspace's own
  // `@intx/workflow` and compare, so the two shapes cannot drift apart.
  {
    const { mkdtemp, mkdir, symlink, writeFile, rm, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { LIFECYCLE_ENTRY_PATH, lifecycleEntrySource, withoutStateSchemas, BUILD_STAGE } = await import(
      "@solutions-builder/app/workflows/lifecycle-source"
    );
    const {
      BUILD_STEP_ID,
      DRAFT_STEP_ID,
      DECIDE_STEP_ID,
      NO_DRAFT_STEP_ID,
      EVALUATE_STEP_ID,
      EVALUATED_STAGE,
      panelStepId,
      audienceStepId,
      reviseStepId: revise,
    } = await import("@solutions-builder/app/workflows/stage-loop");
    const { agentFor, agentById, panelPrincipals } = await import("@solutions-builder/app/kit");

    type AgentStepJson = {
      kind?: string;
      agent?: {
        id?: string;
        toolFactories?: { id?: string }[];
        inference?: { sources?: { provider?: string; model?: string }[] };
      };
      input?: { from?: string };
      after?: string[];
    };
    type IterationJson = {
      steps?: Record<string, AgentStepJson & { kind?: string; then?: string; else?: string; when?: { from?: string } }>;
      stepOrder?: string[];
    };
    type RenderedDefinition = { steps: Record<string, { body?: IterationJson }> };

    /**
     * Strips every `step`/`gate`/`escalation` primitive (and its id from
     * `stepOrder`) out of every iteration body, recursively — the shape a
     * source-less render never carries, so what remains is exactly what the
     * in-process, gates-only definition builds. Generalises the old
     * build-step-only removal to every stage's agent steps at once.
     */
    function stripAgentPrimitives(node: unknown): unknown {
      if (Array.isArray(node)) return node.map(stripAgentPrimitives);
      if (!node || typeof node !== "object") return node;
      const obj = node as Record<string, unknown>;
      if (obj.steps && typeof obj.steps === "object") {
        const rawSteps = obj.steps as Record<string, { kind?: string }>;
        const kept: Record<string, unknown> = {};
        for (const [id, step] of Object.entries(rawSteps)) {
          if (step && ["step", "gate", "escalation"].includes(step.kind ?? "")) continue;
          kept[id] = stripAgentPrimitives(step);
        }
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          if (key === "steps") {
            out.steps = kept;
          } else if (key === "stepOrder" && Array.isArray(value)) {
            out.stepOrder = (value as string[]).filter((id) => id in kept);
          } else {
            out[key] = stripAgentPrimitives(value);
          }
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) out[key] = stripAgentPrimitives(value);
      return out;
    }

    const dir = await mkdtemp(join(tmpdir(), "sb-lifecycle-source-"));
    try {
      await mkdir(join(dir, "node_modules", "@intx"), { recursive: true });
      // The workspace's own copies, by path: a bare-specifier resolve from this
      // script can land on a published tarball in Bun's cache instead.
      for (const name of ["workflow", "agent", "tools-posix"]) {
        const pkg = await realpath(join(import.meta.dir, "..", "node_modules", "@intx", name));
        await symlink(pkg, join(dir, "node_modules", "@intx", name), "dir");
      }
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "check", type: "module" }));
      await writeFile(join(dir, LIFECYCLE_ENTRY_PATH), lifecycleEntrySource());
      // Written before the first import: Bun caches a directory's listing on
      // first resolution, so a module added afterwards is not found.
      const withSourcePath = join(dir, "with-source.js");
      const source = { provider: "openai-compatible", model: "probe" };
      await writeFile(withSourcePath, lifecycleEntrySource({ source }));
      const withAudiencesPath = join(dir, "with-audiences.js");
      const audiences = [
        { name: "A", role: "x" },
        { name: "B", role: "y" },
      ];
      await writeFile(withAudiencesPath, lifecycleEntrySource({ source, audiences }));

      const evaluated = (await import(join(dir, LIFECYCLE_ENTRY_PATH))) as { default: unknown };
      const rendered = JSON.stringify(evaluated.default);
      const inProcess = JSON.stringify(withoutStateSchemas(definition));
      if (rendered !== inProcess) {
        problems.push("The rendered lifecycle source evaluates to a different definition than the package builds in-process");
      }

      const withSource = (await import(withSourcePath)) as { default: RenderedDefinition };
      const withSourceSteps = withSource.default.steps;

      // Stripping every step/gate/escalation out of the drafted render must
      // leave exactly the in-process, gates-only definition: whatever an
      // offering adds is additive, never a different shape underneath it.
      if (JSON.stringify(stripAgentPrimitives(withSource.default)) !== inProcess) {
        problems.push("The lifecycle rendered with a source differs from the package beyond its agent steps");
      }

      // With an offering the build stage's round is followed by the build
      // agent: a real step under the sidecar, with the kit's stage 8 prompt,
      // the posix tools, and the offering as its declared source.
      const buildBody = withSourceSteps[revise(BUILD_STAGE as never)]?.body?.steps ?? {};
      const buildStep = buildBody[BUILD_STEP_ID];
      if (!buildStep || buildStep.kind !== "step" || buildStep.agent?.id !== agentFor(BUILD_STAGE as never).id) {
        problems.push("The build stage's iteration has no agent step for the kit's stage 8 specialist");
      } else {
        if (!buildStep.after?.includes(ROUND_STEP_ID)) problems.push("The build agent does not run after the round gate");
        if (!buildStep.agent?.toolFactories?.some((tool) => tool.id === "@intx/tools-posix/sidecar-bundle")) {
          problems.push("The build agent carries no posix tools");
        }
        const declared = buildStep.agent?.inference?.sources?.[0];
        if (declared?.provider !== source.provider || declared?.model !== source.model) {
          problems.push("The build agent does not declare the offering it was rendered with");
        }
      }

      // Every drafted stage (everything but 5 and 8) is: round, a decide gate
      // reading the round's draft flag, and a draft step for the kit's
      // specialist. Stage 1 also carries the brief evaluator after its draft.
      for (const stage of STAGES) {
        if (stage === 5 || (stage as number) === BUILD_STAGE) continue;
        const iteration = withSourceSteps[revise(stage)]?.body;
        const decide = iteration?.steps?.[DECIDE_STEP_ID];
        const draft = iteration?.steps?.[DRAFT_STEP_ID];
        if (!decide || decide.kind !== "gate" || decide.when?.from !== `steps.${ROUND_STEP_ID}.output.draft`) {
          problems.push(`Stage ${stage}'s decide gate does not read the round's draft flag`);
        } else if (decide.then !== DRAFT_STEP_ID || decide.else !== NO_DRAFT_STEP_ID) {
          problems.push(`Stage ${stage}'s decide gate does not branch to draft/no-draft`);
        }
        if (!draft || draft.kind !== "step" || draft.agent?.id !== agentFor(stage).id) {
          problems.push(`Stage ${stage}'s draft step is not the kit's specialist`);
        } else if (draft.input?.from !== `steps.${ROUND_STEP_ID}.output.prompt`) {
          problems.push(`Stage ${stage}'s draft step does not read the round's prompt`);
        } else if (!draft.after?.includes(DECIDE_STEP_ID)) {
          problems.push(`Stage ${stage}'s draft step does not follow its decide gate`);
        }
        const noDraft = iteration?.steps?.[NO_DRAFT_STEP_ID];
        if (!noDraft || noDraft.kind !== "escalation" || !noDraft.after?.includes(DECIDE_STEP_ID)) {
          problems.push(`Stage ${stage} has no no-draft escalation after its decide gate`);
        }
        if (stage === EVALUATED_STAGE) {
          const evaluator = agentById("brief-evaluator");
          const evaluate = iteration?.steps?.[EVALUATE_STEP_ID];
          if (!evaluate || evaluate.kind !== "step" || evaluate.agent?.id !== evaluator?.id) {
            problems.push("Stage 1 has no brief-evaluator step after its draft");
          } else if (evaluate.input?.from !== `steps.${DRAFT_STEP_ID}.output.reply`) {
            problems.push("Stage 1's evaluator does not read the draft's reply");
          } else if (!evaluate.after?.includes(DRAFT_STEP_ID)) {
            problems.push("Stage 1's evaluator does not follow the draft");
          }
        }
      }

      // Stage 6: the architect drafts, then the four panel principals review
      // it in order, each after the last, all reading the same draft reply.
      {
        const iteration = withSourceSteps[revise(6 as never)]?.body;
        let previous = DRAFT_STEP_ID;
        for (const role of panelPrincipals()) {
          const specialty = role.id.replace(/^senior-engineer-/, "");
          const stepId = panelStepId(specialty);
          const review = iteration?.steps?.[stepId];
          if (!review || review.kind !== "step" || review.agent?.id !== role.id) {
            problems.push(`Stage 6 has no ${stepId} step for ${role.id}`);
          } else if (review.input?.from !== `steps.${DRAFT_STEP_ID}.output.reply`) {
            problems.push(`Stage 6's ${stepId} does not read the draft's reply`);
          } else if (!review.after?.includes(previous)) {
            problems.push(`Stage 6's ${stepId} does not follow ${previous}`);
          }
          previous = stepId;
        }
      }

      // Stage 5: one package step per audience, in order, each reading its
      // own slot of the round's rendered prompts.
      {
        const withAudiences = (await import(withAudiencesPath)) as { default: RenderedDefinition };
        const iteration = withAudiences.default.steps[revise(5 as never)]?.body;
        let previous = DECIDE_STEP_ID;
        audiences.forEach((_audience, index) => {
          const stepId = audienceStepId(index);
          const packageStep = iteration?.steps?.[stepId];
          if (!packageStep || packageStep.kind !== "step" || packageStep.agent?.id !== agentFor(5 as never).id) {
            problems.push(`Stage 5 has no ${stepId} step for the kit's presentation specialist`);
          } else if (packageStep.input?.from !== `steps.${ROUND_STEP_ID}.output.prompts[${index}]`) {
            problems.push(`Stage 5's ${stepId} does not read prompts[${index}]`);
          } else if (!packageStep.after?.includes(previous)) {
            problems.push(`Stage 5's ${stepId} does not follow ${previous}`);
          }
          previous = stepId;
        });

        // Zero audiences renders no package step and no gate either — a
        // stage with no agent step stays gates-only, exactly like today.
        const noAudiences = withSourceSteps[revise(5 as never)]?.body;
        if (Object.keys(noAudiences?.steps ?? {}).some((id) => id !== ROUND_STEP_ID)) {
          problems.push("Stage 5 with no audiences renders more than the round");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
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
