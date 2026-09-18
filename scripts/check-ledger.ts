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

// Not a workspace root dependency (only the rendered lifecycle source names
// it — see the sandbox symlink below), so its id is read by relative path
// rather than a bare specifier that would not resolve here.
const { deck: renderDeckTool } = (await import("../packages/tools-deck/src/sidecar-bundle.ts")) as {
  deck: { id: string };
};
const { delivery: deliveryStatusTool, deliver: deliverTool } = (await import(
  "../packages/tools-delivery/src/sidecar-bundle.ts"
)) as {
  delivery: { id: string };
  deliver: { id: string; definitions: readonly { name: string; approval?: string }[] };
};

const problems: string[] = [];
const seen = new Set<string>();

// Stage 9's own hub approval, not a named signal: the deliver tool must
// declare `approval: "ask"` so the platform parks the specialist's call and
// writes an approval row instead of letting it run straight through.
if (!deliverTool.definitions.some((entry) => entry.name === "deliver" && entry.approval === "ask")) {
  problems.push("The deliver tool does not declare approval: \"ask\"");
}

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
  const { projectLifecycleDefinition, commandsAtStage, stageStepId, NAME_STEP_ID } = await import(
    "@solutions-builder/app/workflows/project-lifecycle"
  );
  const {
    reviseStepId,
    exhaustedStepId,
    exhaustedCapStepId,
    roundSignal,
    approveSignal,
    exhaustedSignal,
    loopExits,
    stageSignal,
    continuingCommands,
    ROUND_STEP_ID,
    GATE_WAIT_STEP_ID,
    ADMIT_STEP_ID,
    evidenceSignal,
    DELIVERY_STAGE,
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
      handler?: string;
      while?: string;
      maxIterations?: number;
      onExhausted?: string;
      after?: string[];
      body?: {
        steps?: Record<string, { kind?: string; name?: string; handler?: string }>;
        stepOrder?: string[];
      };
    }
  >;

  // Every stage is a bounded revise loop followed by two human gate loops
  // (ordinary and exhausted), both on the top-level run so the hub can
  // signal them. A stage that could complete without a person is an
  // automatic advancement, which section 7 forbids.
  for (const stage of STAGES) {
    const revise = steps[reviseStepId(stage)];
    if (!revise || revise.kind !== "loop") {
      problems.push(`The native workflow has no revise loop for stage ${stage}`);
      continue;
    }
    if (typeof revise.maxIterations !== "number" || revise.maxIterations <= 0) {
      problems.push(`Loop ${reviseStepId(stage)} is not bounded`);
    }

    // Stage 9's delivery gate is the specialist's own `deliver` tool call,
    // parked on a stock hub approval — no gate-9/exhausted-9 loop and no
    // approveSignal(9)/exhaustedSignal(9) awaiter exist. Its revise loop
    // routes exhaustion straight to a dead-end park instead of a gate.
    if (stage === DELIVERY_STAGE) {
      if (revise.onExhausted !== exhaustedCapStepId(stage)) {
        problems.push(`Loop ${reviseStepId(stage)} does not route to a dead-end park when exhausted`);
      }
      if (stageStepId(stage) in steps) {
        problems.push(`Stage ${stage} has a gate loop; it must be resolved through the deliver approval instead`);
      }
      if (exhaustedStepId(stage) in steps) {
        problems.push(`Stage ${stage} has an exhaustion gate loop; it must not`);
      }
      const iterationSteps = revise.body?.steps ?? {};
      const awaitSignals = Object.entries(iterationSteps).filter(([, step]) => step.kind === "awaitSignal");
      if (
        awaitSignals.length !== 1 ||
        awaitSignals[0]?.[0] !== ROUND_STEP_ID ||
        awaitSignals[0]?.[1].name !== roundSignal(stage)
      ) {
        problems.push(`Stage ${stage}'s iteration's round is not its only awaitSignal`);
      }
      // stage.draft/stage.submit still ride the round signal, same as every
      // other stage.
      for (const command of loopExits(stage)) {
        if (stageSignal(stage, command).name !== roundSignal(stage)) {
          problems.push(`${command} leaves in_progress but is not a round signal at stage ${stage}`);
        }
      }
      // Every other command that used to land on stage 9's gate
      // (delivery.accept/.reject/.revise, and the generic post-submit
      // governance commands — stage.reject, stage.revise, stage.route_back,
      // stage.select_route, stage.retry, project.archive) rides no workflow
      // signal at stage 9 any more: the deliver tool's approval is the one
      // decision left there. Whether the generic governance commands still
      // need a way to reach stage 9 is a product question outside delivery
      // accept's scope, not answered by this change — see CL-8566.
      continue;
    }

    if (revise.onExhausted !== exhaustedStepId(stage)) {
      problems.push(`Loop ${reviseStepId(stage)} does not route to a gate when exhausted`);
    }
    const gate = steps[stageStepId(stage)];
    const exhausted = steps[exhaustedStepId(stage)];
    function gateLoop(
      step: (typeof steps)[string] | undefined,
      label: string,
      signal: string,
    ): void {
      if (!step || step.kind !== "loop" || step.while !== "gateRefused") {
        problems.push(`${label} is not a gateRefused loop`);
        return;
      }
      if (typeof step.maxIterations !== "number" || step.maxIterations <= 0) {
        problems.push(`${label} is not bounded`);
      }
      const body = step.body?.steps ?? {};
      const wait = body[GATE_WAIT_STEP_ID];
      const admit = body[ADMIT_STEP_ID];
      if (!wait || wait.kind !== "awaitSignal" || wait.name !== signal) {
        problems.push(`${label} does not wait on ${signal}`);
      }
      if (!admit || admit.kind !== "action" || admit.handler !== "admitGate") {
        problems.push(`${label} does not admit through admitGate`);
      }
    }
    gateLoop(exhausted, `Stage ${stage}'s exhaustion`, exhaustedSignal(stage));
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
    gateLoop(gate, `Stage ${stage}'s gate`, approveSignal(stage));
    if (gate && !gate.after?.includes(reviseStepId(stage))) {
      problems.push(`Stage ${stage}'s gate does not follow its revise loop`);
    }
    // Every command the ledger allows out of the stage lands on one of its
    // signals, so the run can never be asked for something it cannot consume.
    for (const command of loopExits(stage)) {
      if (stageSignal(stage, command).name !== roundSignal(stage)) {
        problems.push(`${command} leaves in_progress but is not a round signal at stage ${stage}`);
      }
    }
    for (const command of commandsAtStage(stage)) {
      const { name } = stageSignal(stage, command);
      if (name !== roundSignal(stage) && name !== approveSignal(stage) && name !== evidenceSignal(stage)) {
        problems.push(`${command} has no signal on stage ${stage}'s run`);
      }
    }
  }
  // revise, gate loop, exhausted loop, gate-cap, exhausted-cap for every
  // stage but 9 (revise, exhausted-cap only), plus the freeze loop and its
  // cap between stage 7 and stage 8.
  const expectedStepCount = (STAGES.length - 1) * 5 + 2 + 2;
  if (definition.stepOrder.length !== expectedStepCount) {
    problems.push(
      `The native workflow has ${definition.stepOrder.length} steps for ${STAGES.length} stages, expected ${expectedStepCount}`,
    );
  }

  // No step in the in-process, gates-only definition carries an agent — the
  // naming step is additive, rendered only once an offering exists.
  if (NAME_STEP_ID in steps) {
    problems.push("The in-process lifecycle definition carries a naming step; it must stay gates-only");
  }

  // The deployed package is source, not this object: an entry module the
  // probe sidecar evaluates. Evaluate it here against the workspace's own
  // `@intx/workflow` and compare, so the two shapes cannot drift apart.
  {
    const { mkdtemp, mkdir, symlink, writeFile, rm, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { LIFECYCLE_ENTRY_PATH, lifecycleEntrySource, withoutStateSchemas, BUILD_STAGE, DELIVERY_STAGE } = await import(
      "@solutions-builder/app/workflows/lifecycle-source"
    );
    const {
      BUILD_STEP_ID,
      DRAFT_STEP_ID,
      DELIVERY_STEP_ID,
      DECIDE_STEP_ID,
      ADMIT_DRAFT_STEP_ID,
      NO_DRAFT_STEP_ID,
      EVALUATE_STEP_ID,
      EVALUATED_STAGE,
      EVIDENCE_ADMIT_STEP_ID,
      EVIDENCE_STEP_ID,
      REQUIREMENTS_STEP_ID,
      ROUND_ADMIT_STEP_ID,
      ROUND_DECIDE_STEP_ID,
      ROUND_REFUSED_STEP_ID,
      panelStepId,
      audienceStepId,
      reviseStepId: revise,
      evidenceSignal,
    } = await import("@solutions-builder/app/workflows/stage-loop");
    const { agentFor, agentById, panelPrincipals } = await import("@solutions-builder/app/kit");

    type AgentStepJson = {
      kind?: string;
      name?: string;
      handler?: string;
      agent?: {
        id?: string;
        toolFactories?: { id?: string }[];
        inference?: { sources?: { provider?: string; model?: string }[] };
      };
      input?: { from?: string };
      inference?: { from?: string; literal?: { maxTokens?: number } };
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
          // Evidence park is additive with the offering (it follows the build
          // agent); the in-process, gates-only iteration has none. Same for
          // the round's own admit-draft: it exists only once a drafting round
          // has agent steps to admit ahead of.
          if (id === EVIDENCE_STEP_ID || id === EVIDENCE_ADMIT_STEP_ID || id === ADMIT_DRAFT_STEP_ID) continue;
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
      await mkdir(join(dir, "node_modules", "@solutions-builder"), { recursive: true });
      // The workspace's own copies, by path: a bare-specifier resolve from this
      // script can land on a published tarball in Bun's cache instead.
      for (const name of ["workflow", "agent", "tools-posix"]) {
        const pkg = await realpath(join(import.meta.dir, "..", "node_modules", "@intx", name));
        await symlink(pkg, join(dir, "node_modules", "@intx", name), "dir");
      }
      // Same reasoning for the deck and delivery tools and the app package
      // they depend on: neither tool package is a workspace root dependency
      // (only the rendered lifecycle source names them), so they never land
      // in the workspace's own node_modules; symlink them and their
      // dependency by repo path instead.
      for (const name of ["tools-deck", "tools-delivery"]) {
        await symlink(
          join(import.meta.dir, "..", "packages", name),
          join(dir, "node_modules", "@solutions-builder", name),
          "dir",
        );
      }
      await symlink(
        await realpath(join(import.meta.dir, "..", "node_modules", "@solutions-builder", "app")),
        join(dir, "node_modules", "@solutions-builder", "app"),
        "dir",
      );
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

      // The round is admitted before anything builds: guard.ts runs against
      // the run's own carried build state, and a refused command skips the
      // build agent entirely rather than running it anyway.
      const roundAdmit = buildBody[ROUND_ADMIT_STEP_ID];
      const roundDecide = buildBody[ROUND_DECIDE_STEP_ID];
      const roundRefused = buildBody[ROUND_REFUSED_STEP_ID];
      if (!roundAdmit || roundAdmit.kind !== "action" || roundAdmit.handler !== "admitGate") {
        problems.push("The build stage's round does not admit through admitGate");
      } else if (!roundAdmit.after?.includes(ROUND_STEP_ID)) {
        problems.push("The round admit does not follow the round awaiter");
      }
      if (!roundDecide || roundDecide.kind !== "gate" || roundDecide.when?.from !== `steps.${ROUND_ADMIT_STEP_ID}.output.refused`) {
        problems.push("The round's decide gate does not read the round admit's refusal");
      } else if (roundDecide.then !== ROUND_REFUSED_STEP_ID || roundDecide.else !== BUILD_STEP_ID) {
        problems.push("The round's decide gate does not branch to refused/build");
      }
      if (!roundRefused) problems.push("The build stage's iteration has no refused branch for the round");

      const buildStep = buildBody[BUILD_STEP_ID];
      if (!buildStep || buildStep.kind !== "step" || buildStep.agent?.id !== agentFor(BUILD_STAGE as never).id) {
        problems.push("The build stage's iteration has no agent step for the kit's stage 8 specialist");
      } else {
        if (!buildStep.after?.includes(ROUND_DECIDE_STEP_ID)) {
          problems.push("The build agent does not run after the round's decide gate");
        }
        if (!buildStep.agent?.toolFactories?.some((tool) => tool.id === "@intx/tools-posix/sidecar-bundle")) {
          problems.push("The build agent carries no posix tools");
        }
        const declared = buildStep.agent?.inference?.sources?.[0];
        if (declared?.provider !== source.provider || declared?.model !== source.model) {
          problems.push("The build agent does not declare the offering it was rendered with");
        }
      }

      const evidence = buildBody[EVIDENCE_STEP_ID];
      const evidenceAdmit = buildBody[EVIDENCE_ADMIT_STEP_ID];
      if (
        !evidence ||
        evidence.kind !== "awaitSignal" ||
        evidence.name !== evidenceSignal(BUILD_STAGE as never) ||
        !evidence.after?.includes(BUILD_STEP_ID)
      ) {
        problems.push("The build stage's iteration has no evidence park after the build agent");
      }
      if (!evidenceAdmit || evidenceAdmit.kind !== "action" || evidenceAdmit.handler !== "admitGate") {
        problems.push("The evidence park does not admit through admitGate");
      } else if (!evidenceAdmit.after?.includes(EVIDENCE_STEP_ID)) {
        problems.push("The evidence admit does not follow the evidence awaiter");
      }
      const buildOrder = withSourceSteps[revise(BUILD_STAGE as never)]?.body?.stepOrder ?? [];
      if (
        !buildOrder.includes(ROUND_STEP_ID) ||
        !buildOrder.includes(ROUND_ADMIT_STEP_ID) ||
        !buildOrder.includes(BUILD_STEP_ID) ||
        !buildOrder.includes(EVIDENCE_STEP_ID)
      ) {
        problems.push("Stage 8 with a source is not round, round-admit, build, evidence");
      }

      // The naming step: top level, the kit's namer, reads the run's opening
      // problem statement, and never gates stage 1 — it carries no `after`.
      const namer = agentById("namer");
      const nameStep = withSourceSteps[NAME_STEP_ID] as unknown as AgentStepJson | undefined;
      if (!nameStep || nameStep.kind !== "step" || nameStep.agent?.id !== namer?.id) {
        problems.push("The rendered lifecycle has no naming step for the kit's namer");
      } else {
        if (nameStep.input?.from !== "trigger.payload.problemStatement") {
          problems.push("The naming step does not read the run's opening problem statement");
        }
        if (nameStep.after && nameStep.after.length > 0) {
          problems.push("The naming step gates on something; it must start with the run");
        }
      }
      if (NAME_STEP_ID in (evaluated.default as { steps?: Record<string, unknown> }).steps!) {
        problems.push("The source-less rendered lifecycle carries a naming step");
      }

      // Every drafted stage (everything but 5 and 8) is: round, a decide gate
      // reading the round's draft flag, and a draft step for the kit's
      // specialist. Stage 1 also carries the brief evaluator after its draft.
      // Stage 6's draft sits behind a gate of its own, after the
      // requirements' gate, and is checked in full below.
      for (const stage of STAGES) {
        if (stage === 5 || (stage as number) === BUILD_STAGE) continue;
        // Stage 9 renders its one step under `DELIVERY_STEP_ID`, not
        // `DRAFT_STEP_ID`: the deployed workflow's capability walk refuses a
        // leaf step id that recurs with different grants across loop bodies,
        // and stage 9 alone carries the delivery_status tool.
        const stepId = (stage as number) === DELIVERY_STAGE ? DELIVERY_STEP_ID : DRAFT_STEP_ID;
        const iteration = withSourceSteps[revise(stage)]?.body;
        const decide = iteration?.steps?.[DECIDE_STEP_ID];
        const draft = iteration?.steps?.[stepId];
        const gated = (stage as number) === 6;
        const admitDraft = iteration?.steps?.[ADMIT_DRAFT_STEP_ID];
        if (!admitDraft || admitDraft.kind !== "action" || admitDraft.handler !== "admitDraftGate") {
          problems.push(`Stage ${stage} does not admit its round through admitDraftGate`);
        } else if (!admitDraft.after?.includes(ROUND_STEP_ID)) {
          problems.push(`Stage ${stage}'s admit-draft does not follow the round`);
        }
        if (!decide || decide.kind !== "gate" || decide.when?.from !== `steps.${ADMIT_DRAFT_STEP_ID}.output.draft`) {
          problems.push(`Stage ${stage}'s decide gate does not read the admitted draft flag`);
        } else if (decide.then !== (gated ? "pick-0" : stepId) || decide.else !== NO_DRAFT_STEP_ID) {
          problems.push(`Stage ${stage}'s decide gate does not branch to draft/no-draft`);
        }
        // Stage 4 alone does not trust the round's own inference cap: there
        // is no host route left to police it, so the deploy-time designer
        // setting is baked in as a literal instead (`lifecycle-source.ts`).
        const draftReadsInferenceOffRound =
          (stage as number) === 4
            ? typeof draft?.inference?.literal?.maxTokens === "number"
            : draft?.inference?.from === `steps.${ROUND_STEP_ID}.output.inference`;
        if (!draft || draft.kind !== "step" || draft.agent?.id !== agentFor(stage).id) {
          problems.push(`Stage ${stage}'s draft step is not the kit's specialist`);
        } else if (!draftReadsInferenceOffRound) {
          problems.push(`Stage ${stage}'s draft step does not carry its output-token cap correctly`);
        } else if (!gated && draft.input?.from !== `steps.${ROUND_STEP_ID}.output.prompt`) {
          problems.push(`Stage ${stage}'s draft step does not read the round's prompt`);
        } else if (!gated && !draft.after?.includes(DECIDE_STEP_ID)) {
          problems.push(`Stage ${stage}'s draft step does not follow its decide gate`);
        } else if (
          (stage as number) === DELIVERY_STAGE &&
          !draft.agent?.toolFactories?.some((tool) => tool.id === deliveryStatusTool.id)
        ) {
          problems.push(`Stage ${stage}'s draft step does not carry the delivery_status tool`);
        } else if (
          (stage as number) === DELIVERY_STAGE &&
          !draft.agent?.toolFactories?.some((tool) => tool.id === deliverTool.id)
        ) {
          problems.push(`Stage ${stage}'s draft step does not carry the deliver tool`);
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

      // Stage 6: the requirements author writes, behind a gate reading
      // wanted[0]; the architect drafts behind a gate reading wanted[1] that
      // follows the requirements either way; then the four panel principals
      // review the plan in order, each after the last, all reading the same
      // draft reply. The first review follows the draft alone, so a round
      // that skips the plan skips its reviews with it.
      {
        const iteration = withSourceSteps[revise(6 as never)]?.body;
        const author = agentById("requirements-author");
        const pick0 = iteration?.steps?.["pick-0"];
        const skip0 = iteration?.steps?.["skip-0"];
        const requirements = iteration?.steps?.[REQUIREMENTS_STEP_ID];
        if (!pick0 || pick0.kind !== "gate" || pick0.then !== REQUIREMENTS_STEP_ID || pick0.else !== "skip-0") {
          problems.push("Stage 6 has no pick-0 gate choosing between requirements and skip-0");
        } else if ((pick0.when as { from?: string } | undefined)?.from !== `steps.${ROUND_STEP_ID}.output.wanted[0]`) {
          problems.push("Stage 6's pick-0 does not read wanted[0]");
        } else if (!pick0.after?.includes(DECIDE_STEP_ID)) {
          problems.push("Stage 6's pick-0 does not follow the decide gate");
        }
        if (!skip0 || skip0.kind !== "escalation" || !skip0.after?.includes("pick-0")) {
          problems.push("Stage 6's skip-0 is not an escalation after pick-0");
        }
        if (!requirements || requirements.kind !== "step" || requirements.agent?.id !== author?.id) {
          problems.push("Stage 6 has no requirements step for the kit's requirements author");
        } else if (requirements.input?.from !== `steps.${ROUND_STEP_ID}.output.prompts[0]`) {
          problems.push("Stage 6's requirements step does not read prompts[0]");
        } else if (!requirements.after?.includes("pick-0")) {
          problems.push("Stage 6's requirements step does not follow pick-0");
        }
        const pick1 = iteration?.steps?.["pick-1"];
        const skip1 = iteration?.steps?.["skip-1"];
        const draft = iteration?.steps?.[DRAFT_STEP_ID];
        if (!pick1 || pick1.kind !== "gate" || pick1.then !== DRAFT_STEP_ID || pick1.else !== "skip-1") {
          problems.push("Stage 6 has no pick-1 gate choosing between draft and skip-1");
        } else if ((pick1.when as { from?: string } | undefined)?.from !== `steps.${ROUND_STEP_ID}.output.wanted[1]`) {
          problems.push("Stage 6's pick-1 does not read wanted[1]");
        } else if (![REQUIREMENTS_STEP_ID, "skip-0"].every((id) => pick1.after?.includes(id))) {
          problems.push("Stage 6's pick-1 does not follow requirements and skip-0");
        }
        if (!skip1 || skip1.kind !== "escalation" || !skip1.after?.includes("pick-1")) {
          problems.push("Stage 6's skip-1 is not an escalation after pick-1");
        }
        if (draft?.input?.from !== `steps.${ROUND_STEP_ID}.output.prompts[1]`) {
          problems.push("Stage 6's draft step does not read prompts[1]");
        } else if (!draft.after?.includes("pick-1")) {
          problems.push("Stage 6's draft step does not follow pick-1");
        }
        const firstReview = iteration?.steps?.[panelStepId(panelPrincipals()[0]!.id.replace(/^senior-engineer-/, ""))];
        if (firstReview?.after?.includes("skip-1")) {
          problems.push("Stage 6's first review follows the plan's skip marker, so it would review a plan not written this round");
        }
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
      // own slot of the round's rendered prompts, and each behind a gate of
      // its own that reads the round's "wanted" flag for that audience: a
      // round may write one stakeholder's package again and leave the rest.
      // The gate's empty branch is a skip marker, and the next gate follows
      // both, so the chain goes on whichever way each gate went.
      {
        const withAudiences = (await import(withAudiencesPath)) as { default: RenderedDefinition };
        const iteration = withAudiences.default.steps[revise(5 as never)]?.body;
        const decide = iteration?.steps?.[DECIDE_STEP_ID];
        if (decide?.then !== "pick-0") {
          problems.push(`Stage 5's decide gate does not lead to the first package's gate (leads to ${String(decide?.then)})`);
        }
        let previous: string[] = [DECIDE_STEP_ID];
        audiences.forEach((_audience, index) => {
          const stepId = audienceStepId(index);
          const pickId = `pick-${index}`;
          const skipId = `skip-${index}`;
          const pick = iteration?.steps?.[pickId];
          const skip = iteration?.steps?.[skipId];
          const packageStep = iteration?.steps?.[stepId];
          if (!pick || pick.kind !== "gate" || pick.then !== stepId || pick.else !== skipId) {
            problems.push(`Stage 5 has no ${pickId} gate choosing between ${stepId} and ${skipId}`);
          } else if ((pick.when as { from?: string } | undefined)?.from !== `steps.${ROUND_STEP_ID}.output.wanted[${index}]`) {
            problems.push(`Stage 5's ${pickId} does not read wanted[${index}]`);
          } else if (!previous.every((id) => pick.after?.includes(id))) {
            problems.push(`Stage 5's ${pickId} does not follow ${previous.join(" and ")}`);
          }
          if (!skip || skip.kind !== "escalation" || !skip.after?.includes(pickId)) {
            problems.push(`Stage 5's ${skipId} is not an escalation after ${pickId}`);
          }
          if (!packageStep || packageStep.kind !== "step" || packageStep.agent?.id !== agentFor(5 as never).id) {
            problems.push(`Stage 5 has no ${stepId} step for the kit's presentation specialist`);
          } else if (packageStep.input?.from !== `steps.${ROUND_STEP_ID}.output.prompts[${index}]`) {
            problems.push(`Stage 5's ${stepId} does not read prompts[${index}]`);
          } else if (!packageStep.after?.includes(pickId)) {
            problems.push(`Stage 5's ${stepId} does not follow ${pickId}`);
          } else if (!packageStep.agent?.toolFactories?.some((tool) => tool.id === renderDeckTool.id)) {
            problems.push(`Stage 5's ${stepId} does not carry the render_deck tool`);
          }
          previous = [stepId, skipId];
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
