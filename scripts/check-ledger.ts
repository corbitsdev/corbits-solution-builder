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

// stage.approve must offer cost.approve at stage 7 instead, straight off the
// ledger: `project-lifecycle.ts` deleted its `commandsAtStage` helper along
// with the loop-based shape, and the cost-approval interlock is a ledger
// property, not a workflow one — already asserted above (`approve?.stages`),
// restated here from the stage-7 side for symmetry.
{
  const coversStage7 = (row: (typeof LEDGER)[number]) => row.stages === null || row.stages.includes(7);
  if (LEDGER.some((row) => row.command === "stage.approve" && coversStage7(row))) {
    problems.push("Stage 7 offers stage.approve; it must offer cost.approve instead");
  }
  if (!LEDGER.some((row) => row.command === "cost.approve" && coversStage7(row))) {
    problems.push("Stage 7 does not offer cost.approve");
  }
}

// The native Interchange workflow is generated from this ledger and rendered
// as source for the deployed package (`lifecycle-source.ts`); the two must
// never disagree. It is one `onTrigger` chat section (person mail resumes it,
// every stage — see `chat-section-contract.md`) plus a top-level approve
// chain the hub signals directly: gate-1..gate-8, with a freeze and an
// evidence park between gate-7 and gate-8. No loops, no rounds, no
// exhaustion caps, no MAX_REVISIONS: those all belonged to the old
// loop-per-stage shape and are gone with it.
{
  const { projectLifecycleDefinition, NAME_STEP_ID } = await import(
    "@solutions-builder/app/workflows/project-lifecycle"
  );
  const { approveSignal, freezeSignal, evidenceSignal, gateStepId, CHAT_STEP_ID } = await import(
    "@solutions-builder/app/workflows/stage-loop"
  );

  const definition = projectLifecycleDefinition();
  const steps = definition.steps as Record<
    string,
    {
      kind?: string;
      name?: string;
      after?: string[];
      body?: unknown;
    }
  >;

  // No step in the in-process, gates-only definition carries an agent — the
  // naming step and the chat body's specialists are additive, rendered only
  // once an offering exists.
  if (NAME_STEP_ID in steps) {
    problems.push("The in-process lifecycle definition carries a naming step; it must stay gates-only");
  }

  // The approve chain: gate-1 through gate-8, each an awaitSignal on
  // `approveSignal(stage)`, chained in order by `after`; a freeze and an
  // evidence park sit between gate-7 and gate-8.
  let previous: string | null = null;
  for (let stage = 1; stage <= 7; stage++) {
    const id = gateStepId(stage as never);
    const gateStep = steps[id];
    if (!gateStep || gateStep.kind !== "awaitSignal") {
      problems.push(`${id} is not an awaitSignal step`);
      continue;
    }
    if ((gateStep as { name?: string }).name !== approveSignal(stage as never)) {
      problems.push(`${id} does not wait on ${approveSignal(stage as never)}`);
    }
    if (previous && !gateStep.after?.includes(previous)) {
      problems.push(`${id} does not follow ${previous}`);
    }
    if (stage === 1 && gateStep.after && gateStep.after.length > 0) {
      problems.push("gate-1 must not follow anything; it is the chain's start");
    }
    previous = id;
  }

  const freezeStep = steps["freeze"];
  if (!freezeStep || freezeStep.kind !== "awaitSignal" || (freezeStep as { name?: string }).name !== freezeSignal()) {
    problems.push("freeze does not wait on the freeze signal");
  } else if (!freezeStep.after?.includes(gateStepId(7 as never))) {
    problems.push("freeze does not follow gate-7");
  }

  const evidenceStep = steps["evidence"];
  if (
    !evidenceStep ||
    evidenceStep.kind !== "awaitSignal" ||
    (evidenceStep as { name?: string }).name !== evidenceSignal(8 as never)
  ) {
    problems.push("evidence does not wait on the build stage's evidence signal");
  } else if (!evidenceStep.after?.includes("freeze")) {
    problems.push("evidence does not follow freeze");
  }

  const gate8 = steps[gateStepId(8 as never)];
  if (!gate8 || gate8.kind !== "awaitSignal" || (gate8 as { name?: string }).name !== approveSignal(8 as never)) {
    problems.push("gate-8 does not wait on the approve signal");
  } else if (!gate8.after?.includes("evidence")) {
    problems.push("gate-8 does not follow evidence");
  }

  // The chat section itself: a single onTrigger step, top-level, following
  // nothing — a section never self-completes and nothing may be `after` it.
  const chatStep = steps[CHAT_STEP_ID];
  if (!chatStep || chatStep.kind !== "onTrigger") {
    problems.push("The lifecycle has no top-level onTrigger chat section");
  } else if (chatStep.after && chatStep.after.length > 0) {
    problems.push("The chat section carries an `after`; nothing may follow into it and it may follow nothing");
  }

  // Projects are started by a person, never a schedule or inbound mail.
  if (!definition.triggers.some((trigger) => (trigger as { type?: string }).type === "manual")) {
    problems.push("The native workflow is not manually triggered");
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
    const { DELIVERY_STEP_ID: deliveryStepId } = await import("@solutions-builder/app/workflows/stage-loop");
    const { agentFor, panelPrincipals } = await import("@solutions-builder/app/kit");

    type PrimitiveJson = {
      kind?: string;
      name?: string;
      handler?: string;
      then?: string;
      else?: string;
      when?: { from?: string };
      agent?: {
        id?: string;
        toolFactories?: { id?: string }[];
        inference?: { sources?: { provider?: string; model?: string }[] };
      };
      input?: { from?: string };
      inference?: { from?: string; literal?: { maxTokens?: number } };
      after?: string[];
      body?: { inline?: { steps?: Record<string, PrimitiveJson> } };
    };
    type RenderedDefinition = { steps: Record<string, PrimitiveJson> };

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
      const chatBodyWithSource = withSourceSteps[CHAT_STEP_ID]?.body?.inline?.steps ?? {};

      // The naming step: top level, the kit's namer, reads the run's opening
      // problem statement, and never gates stage 1 — it carries no `after`.
      const namer = (await import("@solutions-builder/app/kit")).agentById("namer");
      const nameStep = withSourceSteps[NAME_STEP_ID];
      if (!nameStep || nameStep.kind !== "step" || nameStep.agent?.id !== namer?.id) {
        problems.push("The rendered lifecycle has no naming step for the kit's namer");
      } else {
        if (nameStep.input?.from !== "trigger.payload") {
          problems.push("The naming step does not read the run's whole trigger payload");
        }
        if (nameStep.after && nameStep.after.length > 0) {
          problems.push("The naming step gates on something; it must start with the run");
        }
      }
      if (NAME_STEP_ID in (evaluated.default as { steps?: Record<string, unknown> }).steps!) {
        problems.push("The source-less rendered lifecycle carries a naming step");
      }

      // The chat body's router: is-1..is-8 pointing at the first agent step of
      // each stage (or `none`), and `route` first.
      const route = chatBodyWithSource["route"];
      if (!route || route.kind !== "action" || route.handler !== "routeMessage") {
        problems.push("The chat body's route step is not an action calling routeMessage");
      } else if (route.input?.from !== "trigger.payload") {
        problems.push("The chat body's route step does not read the run's whole trigger payload");
      }

      // Every stage but 5 and 8 is a draft step reading the router's output,
      // reached through its own `is-N` gate. Stage 1 also carries the brief
      // evaluator after its draft; stage 6's plan sits behind its own
      // requirements step; stage 5 fans out one package per audience.
      for (const stage of [1, 2, 3, 4, 6, 7] as const) {
        const draftId = stage === 6 ? `draft-${stage}` : `draft-${stage}`;
        const isGate = chatBodyWithSource[`is-${stage}`];
        const draft = chatBodyWithSource[draftId];
        if (!isGate || isGate.kind !== "gate" || isGate.when?.from !== `steps.route.output.at.${stage}`) {
          problems.push(`Stage ${stage}'s router gate does not read the routed flag`);
        }
        if (stage !== 6 && (!isGate || isGate.then !== draftId)) {
          problems.push(`Stage ${stage}'s router gate does not lead to its draft step`);
        }
        if (!draft || draft.kind !== "step" || draft.agent?.id !== agentFor(stage as never).id) {
          problems.push(`Stage ${stage}'s draft step is not the kit's specialist`);
          continue;
        }
        if (stage === 4) {
          if (typeof draft.inference?.literal?.maxTokens !== "number") {
            problems.push("Stage 4's draft step does not carry the designer's literal token cap");
          }
        } else if (draft.inference?.from !== "steps.route.output.inference") {
          problems.push(`Stage ${stage}'s draft step does not read the router's inference field`);
        }
        if (stage === 6) {
          if (draft.input?.from !== "steps.requirements-6.output.reply") {
            problems.push("Stage 6's draft step does not read the requirements' reply");
          }
          if (!draft.after?.includes("requirements-6")) {
            problems.push("Stage 6's draft step does not follow the requirements step");
          }
        } else {
          if (draft.input?.from !== "steps.route.output") {
            problems.push(`Stage ${stage}'s draft step does not read the router's output`);
          }
          if (!draft.after?.includes(`is-${stage}`)) {
            problems.push(`Stage ${stage}'s draft step does not follow its router gate`);
          }
        }
      }

      // Stage 1's evaluator.
      const evaluator = (await import("@solutions-builder/app/kit")).agentById("brief-evaluator");
      const evaluate = chatBodyWithSource["evaluate-1"];
      if (!evaluate || evaluate.kind !== "step" || evaluate.agent?.id !== evaluator?.id) {
        problems.push("Stage 1 has no brief-evaluator step after its draft");
      } else if (evaluate.input?.from !== "steps.draft-1.output.reply") {
        problems.push("Stage 1's evaluator does not read the draft's reply");
      } else if (!evaluate.after?.includes("draft-1")) {
        problems.push("Stage 1's evaluator does not follow the draft");
      }

      // Stage 6's requirements step and its panel reviews.
      const requirementsAuthor = (await import("@solutions-builder/app/kit")).agentById("requirements-author");
      const requirements = chatBodyWithSource["requirements-6"];
      const is6 = chatBodyWithSource["is-6"];
      if (!is6 || is6.then !== "requirements-6") {
        problems.push("Stage 6's router gate does not lead to the requirements step");
      }
      if (!requirements || requirements.kind !== "step" || requirements.agent?.id !== requirementsAuthor?.id) {
        problems.push("Stage 6 has no requirements step for the kit's requirements author");
      } else if (requirements.input?.from !== "steps.route.output") {
        problems.push("Stage 6's requirements step does not read the router's output");
      } else if (!requirements.after?.includes("is-6")) {
        problems.push("Stage 6's requirements step does not follow its router gate");
      }
      for (const role of panelPrincipals()) {
        const specialty = role.id.replace(/^senior-engineer-/, "");
        const stepId = `review-6-${specialty}`;
        const review = chatBodyWithSource[stepId];
        if (!review || review.kind !== "step" || review.agent?.id !== role.id) {
          problems.push(`Stage 6 has no ${stepId} step for ${role.id}`);
        } else if (review.input?.from !== "steps.draft-6.output.reply") {
          problems.push(`Stage 6's ${stepId} does not read the plan's reply`);
        } else if (!review.after?.includes("draft-6")) {
          problems.push(`Stage 6's ${stepId} does not follow the plan draft`);
        }
      }

      // Stage 8's build step: the kit's stage 8 specialist, posix tools, the
      // offering it was rendered with, timed out at BUILD_STEP_TIMEOUT_MS.
      const is8 = chatBodyWithSource["is-8"];
      const build = chatBodyWithSource["build-8"];
      if (!is8 || is8.then !== "build-8") {
        problems.push("Stage 8's router gate does not lead to the build step");
      }
      if (!build || build.kind !== "step" || build.agent?.id !== agentFor(BUILD_STAGE as never).id) {
        problems.push("The chat body has no build step for the kit's stage 8 specialist");
      } else {
        if (!build.after?.includes("is-8")) {
          problems.push("The build step does not follow its router gate");
        }
        if (!build.agent?.toolFactories?.some((tool) => tool.id === "@intx/tools-posix/sidecar-bundle")) {
          problems.push("The build step carries no posix tools");
        }
        const declared = build.agent?.inference?.sources?.[0];
        if (declared?.provider !== source.provider || declared?.model !== source.model) {
          problems.push("The build step does not declare the offering it was rendered with");
        }
      }

      // Stage 9's delivery-check step: standalone, after gate-8, carrying the
      // delivery-status and deliver tools — not part of the chat body's router,
      // since routeMessage's output only ever carries flags for stages 1..8.
      const delivery = withSourceSteps[deliveryStepId];
      if (!delivery || delivery.kind !== "step" || delivery.agent?.id !== agentFor(DELIVERY_STAGE as never).id) {
        problems.push("The rendered lifecycle has no delivery-check step for the kit's stage 9 specialist");
      } else {
        if (!delivery.after?.includes(gateStepId(8 as never))) {
          problems.push("The delivery-check step does not follow gate-8");
        }
        if (!delivery.agent?.toolFactories?.some((tool) => tool.id === deliveryStatusTool.id)) {
          problems.push("The delivery-check step does not carry the delivery_status tool");
        }
        if (!delivery.agent?.toolFactories?.some((tool) => tool.id === deliverTool.id)) {
          problems.push("The delivery-check step does not carry the deliver tool");
        }
      }
      if (deliveryStepId in chatBodyWithSource) {
        problems.push("The delivery-check step is wired into the chat body's router; it must be standalone");
      }

      // Stage 5: one package step per audience, all reached directly off
      // `is-5` (a round may write one stakeholder's package again and leave
      // the rest, so nothing chains them to each other).
      {
        const withAudiences = (await import(withAudiencesPath)) as { default: RenderedDefinition };
        const chatBodyWithAudiences =
          withAudiences.default.steps[CHAT_STEP_ID]?.body?.inline?.steps ?? {};
        const is5 = chatBodyWithAudiences["is-5"];
        if (!is5 || is5.then !== "package-5-0") {
          problems.push("Stage 5's router gate does not lead to the first package step");
        }
        audiences.forEach((_audience, index) => {
          const stepId = `package-5-${index}`;
          const packageStep = chatBodyWithAudiences[stepId];
          if (!packageStep || packageStep.kind !== "step" || packageStep.agent?.id !== agentFor(5 as never).id) {
            problems.push(`Stage 5 has no ${stepId} step for the kit's presentation specialist`);
          } else if (packageStep.input?.from !== "steps.route.output") {
            problems.push(`Stage 5's ${stepId} does not read the router's output`);
          } else if (!packageStep.after?.includes("is-5")) {
            problems.push(`Stage 5's ${stepId} does not follow its router gate`);
          } else if (!packageStep.agent?.toolFactories?.some((tool) => tool.id === renderDeckTool.id)) {
            problems.push(`Stage 5's ${stepId} does not carry the render_deck tool`);
          }
        });

        // Zero audiences renders no package step, and its router gate leads
        // straight to `none` — a stage with no agent step stays gates-only.
        const chatBodyNoAudiences = withSourceSteps[CHAT_STEP_ID]?.body?.inline?.steps ?? {};
        if (Object.keys(chatBodyNoAudiences).some((id) => id.startsWith("package-5-"))) {
          problems.push("Stage 5 with no audiences renders a package step");
        }
        if (chatBodyNoAudiences["is-5"]?.then !== "none") {
          problems.push("Stage 5 with no audiences does not route straight to none");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
