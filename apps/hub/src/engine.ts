/**
 * The command engine — BUILD_PLAN_V3 sections 6, 7 and 11.
 *
 * One entry point for every state change. It:
 *   1. dedupes on the envelope's idempotency key (at-least-once is assumed);
 *   2. resolves the actor's real authorities from the platform (`hub/authority.ts`);
 *   3. asks the guard whether the ledger permits the command;
 *   4. commits the state change;
 *   5. records the command as a ledger mail turn and fires any decision
 *      notification, both after the transaction has committed.
 *
 * Step 4 is why this is one module and not several: the atomicity claim is only
 * true if there is a single place that writes.
 */
import type { Command, Stage } from "@solutions-builder/app/ledger";
import { LEDGER, PROJECT_DELETE } from "@solutions-builder/app/ledger";
import { evaluate, evaluateAudienceDecision, type GuardContext, type RunView } from "./guard.js";
import { HostError, notFound } from "./errors.js";
import { newId } from "./ids.js";
import { database, type Db } from "./db.js";
import type { Authority } from "@solutions-builder/app/ledger";
import { launchProjectLifecycle, type DeliveryOutcome } from "./hub-executor.js";
import { loadRun } from "./engine-views.js";
import { RunDraft, activeRun, readRun, runsForProject } from "./runs.js";
import {
  authoritiesFor,
  versionHashesMatch,
  audienceTally,
  packetExists,
} from "./engine-approvals.js";
import {
  recordCommand,
  receiptFor,
  audienceDecisions,
  openQuestion,
  type BuildAnswer,
  type BuildQuestion,
  type DecisionFlag,
  type RetentionReceipt,
} from "./engine-ledger.js";
import { eq } from "drizzle-orm";
import * as table from "./schema.js";
import { writeArtifact } from "./projects.js";
import type { ArtifactDraft } from "./domain.js";
import { describeBlockers, normalizeDescriptor, type DeliveryManifest } from "@solutions-builder/app/delivery";
import { latestManifest, verifyAndRecord } from "./delivery.js";
import { readVerifierReport } from "./completion-judge.js";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDirectory } from "./paths.js";
import { runGateSideEffects } from "./engine-recovery.js";
import { notifyDecision } from "./notify.js";
import { readProject, updateProject, type ProjectPolicy } from "./project-tenant.js";

export { requiredAuthorityFor, soloApprovalFor } from "./engine-approvals.js";

/**
 * Launches a project's `project-lifecycle` run in the runtime executor. Called
 * once, right after `store/projects.ts` commits the project and its first
 * run — outside any transaction, since the executor is not something the
 * database's single writer connection can be reached from mid-transaction.
 */
export async function launchProjectRun(args: {
  readonly projectId: string;
}): Promise<void> {
  await launchProjectLifecycle(args);
}

export type Actor = { readonly principalId: string; readonly displayName: string };

/**
 * The host's own principal. It holds `system` authority and nothing else, which
 * is what lets the host relay a verified worker request (`build.wait_for_human`)
 * without any human appearing to have made it. It cannot cross a gate: no
 * ledger row that transitions a stage names `system` as an authority.
 */
export const HOST_PRINCIPAL = "p_host";

export type { ProjectPolicy } from "./project-tenant.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CommandInput = {
  readonly type: Command;
  readonly actor: Actor;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /**
   * The project revision the caller believes it is acting on — §6's
   * "expected mutable revision". Optional, because a caller that has not read
   * the project cannot claim one; supplied, it is enforced.
   */
  readonly expectedRevision?: number;
  readonly payload: Record<string, unknown>;
};

export type CommandOutcome = {
  readonly runId: string;
  readonly stage: Stage;
  readonly state: string;
  readonly transitionId: string;
  readonly replayed: boolean;
  /**
   * What `runGateSideEffects` did with the signal this command produced.
   * Present only for a gate command; a caller that needs the round to have
   * actually reached a waiting run (a drafting request) reads this rather
   * than assuming delivery from a bare commit.
   */
  readonly delivery?: DeliveryOutcome;
};

type VersionRef = { artifactId: string; versionId: string; contentHash: string };

function createRun(
  draft: RunDraft,
  args: {
    projectId: string;
    kind: "stage" | "build";
    stage: Stage;
    state: string;
    sourceRunId?: string | null;
    packetId?: string | null;
    checkpointRef?: string | null;
  },
): string {
  const id = newId.run();
  return draft.create({
    id,
    projectId: args.projectId,
    kind: args.kind,
    stage: args.stage,
    state: args.state as RunView["state"],
    sourceRunId: args.sourceRunId ?? null,
    // A new run is its own origin; attempts of it inherit this id.
    originId: id,
    terminalReason: null,
    costApprovalVersionId: null,
    routeTargetStage: null,
    packetId: args.packetId ?? null,
    checkpointRef: args.checkpointRef ?? null,
    createdAt: new Date(),
    endedAt: null,
  });
}

/**
 * In-flight commands, keyed by idempotency key. A concurrent retry — one that
 * arrives while the first call is still running — awaits the same promise
 * rather than starting a second `runCommand`, which is what a database-backed
 * receipt row used to guard against. The map only ever holds a command while
 * it is actually running: nothing here is durable, and it does not need to
 * be, because the ledger mail turn `runCommand` writes on the way out is what
 * a *sequential* replay (arriving after the first call has already returned)
 * reads back.
 */
const inflight = new Map<string, Promise<CommandOutcome>>();

export function execute(input: CommandInput): Promise<CommandOutcome> {
  const existing = inflight.get(input.idempotencyKey);
  if (existing) return existing.then((result) => ({ ...result, replayed: true }));

  const attempt = (async (): Promise<CommandOutcome> => {
    const replayed = await receiptFor(input.projectId, input.idempotencyKey);
    if (replayed) return replayed;

    try {
      return await runCommand(input);
    } catch (cause) {
      // The retry that lost the race: the winner has already committed, so the
      // refusal it just got is the wrong answer to give back.
      const settled = await receiptFor(input.projectId, input.idempotencyKey);
      if (settled) return settled;
      throw cause;
    }
  })();

  inflight.set(input.idempotencyKey, attempt);
  return attempt.finally(() => inflight.delete(input.idempotencyKey));
}

/**
 * The one-action approval: `stage.submit` immediately followed by whichever
 * command actually leaves `waiting_approval` at this stage (`stage.approve`
 * for stages 1-6, `cost.approve` at stage 7 — stage 7 never accepts
 * `stage.approve`, per the ledger's own forbidden-transition note).
 *
 * Both commands still go through `execute` — through the guard, through
 * authority, through the audit trail — so this changes nothing about what is
 * allowed, only how many times a solo approver has to say so. If the submit
 * commits and the approval is then refused (a stale version, a quorum not
 * yet met), that refusal is what the caller sees: the submit is not rolled
 * back, and the run is left exactly where a plain `stage.submit` would have
 * left it — `waiting_approval`.
 */
export async function submitAndApprove(input: {
  readonly actor: Actor;
  readonly projectId: string;
  readonly runId: string;
  readonly versions: unknown[];
  readonly rationale?: string;
  readonly forecastUsd?: number;
  readonly assumptions?: unknown;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly expectedRevision?: number;
}): Promise<CommandOutcome> {
  const before = await readRun(input.runId, input.projectId);
  if (!before) throw notFound("That run");

  // A stage already sent for review — stage 5's packages go when the first
  // stakeholder decides — has nothing left to submit; only the approval
  // remains, checked against the revision the caller saw.
  const alreadySubmitted = before.state === "waiting_approval";
  const submitted = alreadySubmitted
    ? { runId: input.runId }
    : await execute({
        type: "stage.submit",
        actor: input.actor,
        projectId: input.projectId,
        idempotencyKey: `${input.idempotencyKey}#submit`,
        correlationId: input.correlationId,
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
        payload: { runId: input.runId, versions: input.versions },
      });

  const approveType: Command = before.stage === 7 ? "cost.approve" : "stage.approve";
  return execute({
    type: approveType,
    actor: input.actor,
    projectId: input.projectId,
    // The submit above already advanced the project's revision; re-checking
    // the caller's original one against the post-submit row would refuse a
    // legitimate chain, so the second step trusts the first rather than
    // re-asserting a revision that has deliberately moved.
    idempotencyKey: `${input.idempotencyKey}#approve`,
    correlationId: input.correlationId,
    ...(alreadySubmitted && input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    payload: {
      runId: submitted.runId,
      versions: input.versions,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.forecastUsd !== undefined ? { forecastUsd: input.forecastUsd } : {}),
      ...(input.assumptions !== undefined ? { assumptions: input.assumptions } : {}),
    },
  });
}

/**
 * `project.delete` acts on the project, not on a run, so it never reaches the
 * run guard. Its authority and effects come from `PROJECT_DELETE`, and
 * "tombstone" means exactly that: the rows stay, the project stops being
 * readable. Nothing here removes what a person wrote.
 */
function expectRevision(input: CommandInput, current: number): void {
  if (input.expectedRevision !== undefined && input.expectedRevision !== current) {
    throw new HostError(
      "conflict",
      `This project has changed since you loaded it (revision ${current}, you had ${input.expectedRevision}). Reload and decide again.`,
      { expected: input.expectedRevision, current },
    );
  }
}

async function runProjectDelete(input: CommandInput, authorities: Authority[]): Promise<CommandOutcome> {
  const authorised = PROJECT_DELETE.authority.some((role) => authorities.includes(role));
  if (!authorised) {
    throw new HostError(
      "not_authorized",
      `Deleting a project is ${PROJECT_DELETE.authority.join(" or ")}'s decision.`,
    );
  }

  const deletedAt = new Date();
  const project = await readProject(input.projectId);
  if (!project) throw notFound("That project");
  expectRevision(input, project.revision);
  await updateProject(input.projectId, { deletedAt });

  // The retention receipt: what this deletion removed, recorded on the same
  // turn as the deletion so it cannot be lost or edited apart from it. The
  // document versions stay in the artifact store (the tenant row is marked,
  // never dropped); the build workspaces on disk are removed here.
  const receipt = await retentionReceipt(input.projectId, deletedAt);

  const open = await activeRun(input.projectId);
  const result: CommandOutcome = {
    runId: open?.id ?? "",
    stage: (open?.stage ?? 1) as Stage,
    state: (open?.state ?? "in_progress") as CommandOutcome["state"],
    transitionId: "project.delete",
    replayed: false,
  };

  await recordCommand({
    projectId: input.projectId,
    actorPrincipalId: input.actor.principalId,
    authority: PROJECT_DELETE.authority[0] ?? null,
    command: input.type,
    transitionId: "project.delete",
    correlationId: input.correlationId,
    before: { deletedAt: null },
    after: { deletedAt: deletedAt.toISOString(), effects: PROJECT_DELETE.effects },
    idempotencyKey: input.idempotencyKey,
    result,
    receipt,
  });

  return result;
}

async function retentionReceipt(projectId: string, deletedAt: Date): Promise<RetentionReceipt> {
  const { db } = database();
  const nodes = await db
    .select({ id: table.artifactNode.id })
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId));
  const removedWorkspaces: string[] = [];
  for (const run of await runsForProject(projectId)) {
    const workspace = join(dataDirectory(), "builds", run.id);
    if (!existsSync(workspace)) continue;
    await rm(workspace, { recursive: true, force: true });
    removedWorkspaces.push(workspace);
  }
  return {
    deletedAt: deletedAt.toISOString(),
    retainedArtifactNodeIds: nodes.map((node) => node.id),
    removedWorkspaces,
  };
}

async function runCommand(input: CommandInput): Promise<CommandOutcome> {
  const { db } = database();
  // Resolved before the transaction opens: the platform's grant tables live
  // on a separate connection binding than `tx`, and pglite is single-writer —
  // querying them from inside an open `db.transaction` callback deadlocks
  // against that same transaction rather than reading through it.
  const authorities = await authoritiesFor(input.projectId, input.actor.principalId);

  if (input.type === "project.delete") return runProjectDelete(input, authorities);

  const runId = String(input.payload.runId ?? "");
  if (!runId) throw new HostError("validation_failed", "The command must name a run.");
  const run = await loadRun(runId, input.projectId);
  // The run mutations this command makes are collected here and written to
  // the ledger after the transaction returns, since the ledger mail lives on
  // the same single-writer connection as `tx`.
  const draft = new RunDraft(await runsForProject(input.projectId));

  const versions = Array.isArray(input.payload.versions) ? (input.payload.versions as VersionRef[]) : [];
  const needsExactVersions = (
    ["stage.approve", "cost.approve", "build.freeze", "audience.decide"] as string[]
  ).includes(input.type);

  // The guard's ledger-backed inputs, resolved before the transaction opens
  // for the same reason `authoritiesFor` is: the ledger mail lives on the same
  // single-writer connection as `tx`, so reading it from inside an open
  // transaction on that connection deadlocks rather than reading through it.
  // The project is the hub's tenant row, read before the transaction for the
  // same reason; the revision check is §6's optimistic concurrency.
  const project = await readProject(input.projectId);
  if (!project) throw notFound("That project");
  expectRevision(input, project.revision);
  const policy = project.policy;

  let audienceGuard: { required: number; proceeded: number; blocked: number } | undefined;
  if (input.type === "stage.approve" && run.stage === 5) {
    audienceGuard = await audienceTally(input.projectId, run.id, policy);
  }
  if (input.type === "audience.decide") {
    const audienceName = String(input.payload.audienceName ?? "");
    const already = (await audienceDecisions(input.projectId, run.id)).some(
      (decision) => decision.audienceName === audienceName,
    );
    if (already) {
      // A recorded audience decision is immutable. Changing one means routing
      // the stage back and reviewing a new package version.
      throw new HostError(
        "conflict",
        `${audienceName} has already recorded a decision on this review. ` +
          `Route the stage back to review a new package version.`,
      );
    }
  }

  // The open worker question is a ledger fact too, so it is read here for the
  // same reason: build.answer resumes exactly the attempt that asked.
  const waiting = input.type === "build.answer" ? await openQuestion(input.projectId, run.id) : undefined;

  // Stage 9 accepts bytes, not a manifest: the latest manifest is verified
  // again now, and a required descriptor that is missing, mismatched or
  // unreachable refuses the acceptance and names itself.
  if (input.type === "delivery.accept") {
    const version = await latestManifest(input.projectId);
    if (!version) throw new HostError("transition_refused", "There is no delivery manifest to accept.");
    const report = await verifyAndRecord(input.projectId, version, input.actor);
    if (!report.complete) {
      throw new HostError("transition_refused", describeBlockers(report) ?? "Delivery evidence is incomplete.", {
        failed: report.failed,
        items: report.items,
      });
    }
  }

  const outcome = await db.transaction(async (tx) => {
    const context: GuardContext = {
      actorAuthorities: authorities,
      ...(typeof input.payload.targetStage === "number"
        ? { targetStage: input.payload.targetStage as Stage }
        : {}),
      ...(needsExactVersions
        ? { versionHashesMatch: await versionHashesMatch(tx, versions) }
        : {}),
      ...(input.type === "build.freeze"
        ? {
            frozenPacketExists: await packetExists(tx, run.id),
          }
        : {}),
      ...(audienceGuard ? { audience: audienceGuard } : {}),
      ...(input.type === "build.answer" ? { waitingRequestOriginId: waiting?.originId ?? "" } : {}),
      // Checkpoint resume is verified only when a worker actually returned a
      // checkpoint it advertises as resumable. The bounded bridge returns none,
      // so resume is refused there rather than faked.
      ...(input.type === "build.resume"
        ? { checkpointResumeVerified: run.checkpointRef !== null }
        : {}),
    };

    const verdict =
      input.type === "audience.decide"
        ? evaluateAudienceDecision(run, context)
        : evaluate(input.type, run, context);

    if (!verdict.ok) {
      throw new HostError("transition_refused", verdict.message, { refusal: verdict.code });
    }

    const applied = await apply(tx, draft, {
      input,
      run,
      policy,
      versions,
      transitionId: verdict.transition.id,
      toStage: verdict.toStage,
      authority: authorities[0] ?? "project_owner",
      ...(waiting ? { openQuestionId: waiting.id } : {}),
    });

    const result: CommandOutcome = {
      runId: applied.runId,
      stage: applied.stage,
      state: applied.state,
      transitionId: verdict.transition.id,
      replayed: false,
    };
    return {
      result,
      applied,
      before: { runId: run.id, state: run.state, stage: run.stage },
    };
  });

  // The project moves on with every command that commits, which is what makes
  // the expected-revision check mean anything: a revision that only changed
  // on archive could never catch a stale decision.
  await updateProject(input.projectId, input.type === "project.archive" ? { archivedAt: new Date() } : {});

  // A frozen packet or a delivery manifest is an artifact version, written
  // after the transaction because the artifact store opens its own. The run
  // that carries the packet learns the version id before the ledger turn is
  // written, so the fold sees both together.
  if (outcome.applied.artifact) {
    const written = await writeArtifact(outcome.applied.artifact.draft, input.actor);
    const carrier = outcome.applied.artifact.setPacketOn;
    if (carrier) draft.patch(carrier, { packetId: written.nodeId });
    // A manifest is checked the moment it exists, so the stage 9 decision
    // opens knowing what is missing rather than discovering it on accept.
    if (outcome.applied.artifact.verifyDelivery) {
      const version = await latestManifest(input.projectId);
      if (version) await verifyAndRecord(input.projectId, version, input.actor);
    }
  }

  await recordCommand({
    projectId: input.projectId,
    actorPrincipalId: input.actor.principalId,
    authority: authorities[0] ?? null,
    command: input.type,
    transitionId: outcome.result.transitionId,
    correlationId: input.correlationId,
    before: outcome.before,
    after: { runId: outcome.applied.runId, state: outcome.applied.state, stage: outcome.applied.stage },
    idempotencyKey: input.idempotencyKey,
    result: outcome.result,
    stage: run.stage,
    runId: outcome.applied.runId,
    runs: draft.mutations,
    ...(outcome.applied.flag ? { flag: outcome.applied.flag } : {}),
    ...(outcome.applied.question ? { question: outcome.applied.question } : {}),
    ...(outcome.applied.answer ? { answer: outcome.applied.answer } : {}),
    ...(outcome.applied.approval ?? {}),
  });

  if (outcome.applied.notifyRunId) {
    await notifyDecision(input.projectId, outcome.applied.notifyRunId).catch(() => undefined);
  }

  // Outside the transaction — the executor is not something the database's
  // single writer connection can be reached from mid-transaction, and this is
  // a best-effort shadow of the transition, not part of what made it valid.
  const delivery = await runGateSideEffects(input, outcome.before);

  return delivery === undefined ? outcome.result : { ...outcome.result, delivery };
}

/** A decision recorded on this run, carried through to the post-commit ledger write. */
export type AppliedApproval = {
  decision: string;
  audienceName?: string | null;
  versions?: unknown;
  rationale?: string | null;
  assumptions?: unknown;
};

export type AppliedCommand = {
  runId: string;
  stage: Stage;
  state: string;
  /** Set when this transition records a decision — the ledger's `approvals` shape. */
  approval?: AppliedApproval;
  /** Set when this transition parks a run on a person; notified after commit. */
  notifyRunId?: string;
  /** Set when this transition raises a decision flag, recorded on the ledger turn. */
  flag?: DecisionFlag;
  /** Set when this transition asks a person something on the worker's behalf. */
  question?: BuildQuestion;
  /** Set when this transition answers an open worker question. */
  answer?: BuildAnswer;
  /**
   * Set when this transition produces an artifact version (a frozen packet, a
   * delivery manifest). Written after commit; `setPacketOn` names the run whose
   * `packetId` becomes the written version.
   */
  artifact?: { draft: ArtifactDraft; setPacketOn?: string; verifyDelivery?: boolean };
};

/**
 * The durable effects of an allowed transition. Everything here runs inside the
 * caller's transaction; nothing here re-checks a rule the guard already owns.
 */
async function apply(
  tx: Tx,
  draft: RunDraft,
  args: {
    input: CommandInput;
    run: RunView;
    policy: ProjectPolicy;
    versions: VersionRef[];
    transitionId: string;
    toStage: Stage;
    authority: Authority;
    openQuestionId?: string;
  },
): Promise<AppliedCommand> {
  const { input, run, toStage } = args;
  const now = new Date();

  const approvalOf = (decision: string, audienceName?: string): AppliedApproval => ({
    decision,
    audienceName: audienceName ?? null,
    versions: args.versions,
    rationale: (input.payload.rationale as string | undefined) ?? null,
    assumptions: (input.payload.assumptions as unknown) ?? null,
  });

  const terminalize = (state: string, reason: string) => {
    draft.patch(run.id, { state: state as RunView["state"], terminalReason: reason, endedAt: now });
  };

  switch (input.type) {
    case "audience.decide": {
      const audienceName = String(input.payload.audienceName ?? "");
      const decision = String(input.payload.decision ?? "proceed");
      // The immutability rule (an audience only decides once) is checked
      // before the transaction opens, against the ledger.
      // Record-only: the run does not move, by design.
      return {
        runId: run.id,
        stage: run.stage,
        state: run.state,
        approval: approvalOf(decision, audienceName),
      };
    }

    case "stage.draft": {
      // Keeps the stage open: no run mutation, no approval, no notify. Its
      // only durable effect is the round signal `runGateSideEffects` delivers
      // to the run after this command commits.
      return { runId: run.id, stage: run.stage, state: run.state };
    }

    case "stage.submit": {
      draft.patch(run.id, { state: "waiting_approval" });
      return { runId: run.id, stage: run.stage, state: "waiting_approval", notifyRunId: run.id };
    }

    case "stage.approve": {
      terminalize("approved", "approved and advanced");
      const next = createRun(draft, {
        projectId: input.projectId,
        kind: "stage",
        stage: toStage,
        state: "in_progress",
        sourceRunId: run.id,
      });
      return { runId: next, stage: toStage, state: "in_progress", approval: approvalOf("approve") };
    }

    case "cost.approve": {
      // No stage advance. The cost approval is a field on this run, and
      // build.freeze is the only thing that reads it.
      draft.patch(run.id, {
        state: "cost_approved",
        costApprovalVersionId: args.versions[0]?.versionId ?? null,
      });
      return { runId: run.id, stage: 7, state: "cost_approved", approval: approvalOf("approve") };
    }

    case "build.freeze": {
      // The frozen packet is an artifact version of its own: the exact
      // versions it freezes are its sources, the freezing person its producer,
      // and the stage 7 run its producer run, which is what a second freeze
      // for the same source is refused against.
      const packet = {
        versions: args.versions,
        placement: String(input.payload.placement ?? "local"),
        targets: (input.payload.targets as unknown) ?? [],
        costApproval: { versionId: run.costApprovalVersionId },
      };
      const draftPacket: ArtifactDraft = {
        projectId: input.projectId,
        kind: "build_packet",
        title: "Build packet",
        content: JSON.stringify(packet, null, 2),
        mediaType: "application/json",
        sourceVersionIds: args.versions.map((version) => version.versionId),
        provenance: { producer: "human", runId: run.id },
      };
      // Stage 7 is terminal from here. It never returns to in_progress;
      // a material change re-enters through stage.backtracked routing.
      terminalize("approved_frozen", "packet frozen");
      const buildRun = createRun(draft, {
        projectId: input.projectId,
        kind: "build",
        stage: 8,
        state: "queued",
        sourceRunId: run.id,
      });
      return {
        runId: buildRun,
        stage: 8,
        state: "queued",
        artifact: { draft: draftPacket, setPacketOn: buildRun },
      };
    }

    case "build.start_attempt": {
      if (run.state === "queued") {
        draft.patch(run.id, { state: "running" });
        return { runId: run.id, stage: 8, state: "running" };
      }
      // From a terminal build run: a new queued run linked to the unchanged source.
      const source = draft.get(run.id);
      const next = createRun(draft, {
        projectId: input.projectId,
        kind: "build",
        stage: 8,
        state: "queued",
        sourceRunId: run.id,
        packetId: source?.packetId ?? null,
      });
      return { runId: next, stage: 8, state: "queued" };
    }

    case "build.wait_for_human": {
      draft.patch(run.id, { state: "waiting_human" });
      const question: BuildQuestion = {
        id: newId.question(),
        runId: run.id,
        originId: run.originId,
        kind: String(input.payload.kind ?? "question"),
        prompt: String(input.payload.prompt ?? ""),
        scopeImpact: (input.payload.scopeImpact as unknown) ?? null,
      };
      return { runId: run.id, stage: 8, state: "waiting_human", notifyRunId: run.id, question };
    }

    case "build.answer": {
      // The answer is the outcome of this command, joined to the question by
      // id. The same queued-origin attempt resumes. No new run, no origin change.
      const answer: BuildAnswer = {
        questionId: args.openQuestionId ?? "",
        answer: String(input.payload.answer ?? ""),
        grantedCapabilities: (input.payload.grantedCapabilities as unknown) ?? null,
      };
      draft.patch(run.id, { state: "running" });
      return { runId: run.id, stage: 8, state: "running", answer };
    }

    case "build.accept_evidence": {
      // §7's first precondition: a complete verifier report. The report
      // itself renders no verdict on whether the evidence is good enough —
      // that is the second precondition, the human decision this command's
      // own authority check already is (guard.ts: only project_owner or
      // technical_approver may issue it) — it only has to exist. A run whose
      // attempt never produced one (the worker was unavailable, or timed out
      // before the judge could run even mechanically) has nothing here for a
      // human to accept against, so acceptance is refused outright rather
      // than silently treated as "no evidence problem".
      const verifierReport = readVerifierReport(input.payload.verifierReport);
      if (!verifierReport) {
        throw new HostError(
          "validation_failed",
          "build.accept_evidence requires a completed verifier report. No verification was performed for this build attempt, so there is nothing for a human to accept against.",
        );
      }
      terminalize("evidence_accepted", `evidence accepted — verifier report: ${verifierReport.level} confidence (${verifierReport.source})`);
      // The manifest is an artifact version produced by the build run.
      const rawDescriptors = Array.isArray(input.payload.descriptors) ? input.payload.descriptors : [];
      const descriptors = rawDescriptors.map(normalizeDescriptor);
      if (descriptors.some((entry) => entry === null)) {
        throw new HostError("validation_failed", "Every delivery descriptor needs a path, a 64-hex SHA-256 and a size.");
      }
      const actualCost = typeof input.payload.actualCost === "number" ? input.payload.actualCost : null;
      const suppliedVerification =
        typeof input.payload.verification === "object" && input.payload.verification !== null
          ? (input.payload.verification as Record<string, unknown>)
          : {};
      const manifest: DeliveryManifest = {
        descriptors: descriptors as NonNullable<(typeof descriptors)[number]>[],
        costForecast: typeof input.payload.costForecast === "number" ? input.payload.costForecast : null,
        costActual: actualCost,
        // The bounded bridge meters nothing, so an absent actual is recorded as
        // absent with the reason, never as zero.
        costActualReason: actualCost === null ? "the build worker reported no metered cost" : null,
        // The verifier's own verdict travels with the manifest, honest and
        // unfiltered — a low confidence level and its reasoning are carried
        // forward exactly as reported, never hidden behind a bare "accepted".
        verification: { ...suppliedVerification, verifierReport },
        exceptions: (input.payload.exceptions as unknown) ?? null,
      };
      const draftManifest: ArtifactDraft = {
        projectId: input.projectId,
        kind: "delivery_manifest",
        title: "Delivery manifest",
        content: JSON.stringify(manifest, null, 2),
        mediaType: "application/json",
        sourceVersionIds: args.versions.map((version) => version.versionId),
        provenance: { producer: "human", runId: run.id },
      };
      const delivery = createRun(draft, {
        projectId: input.projectId,
        kind: "stage",
        stage: 9,
        state: "delivery_review",
        sourceRunId: run.id,
      });
      return {
        runId: delivery,
        stage: 9,
        state: "delivery_review",
        approval: approvalOf("accept"),
        notifyRunId: delivery,
        artifact: { draft: draftManifest, verifyDelivery: true },
      };
    }

    case "delivery.accept": {
      // Acceptance is this command's own ledger turn; the manifest version
      // it accepts is unchanged.
      terminalize("delivered", "accepted by the recipient");
      return { runId: run.id, stage: 9, state: "delivered", approval: approvalOf("accept") };
    }

    case "project.archive":
      // The tenant write happens after the transaction, with the revision bump.
      return { runId: run.id, stage: run.stage, state: "archived" };

    case "stage.reject":
    case "stage.revise":
    case "stage.route_back":
    case "delivery.reject":
    case "delivery.revise":
    case "build.route_material_change": {
      const reason = String(input.payload.reason ?? "");
      const flag: DecisionFlag = {
        id: newId.flag(),
        runId: run.id,
        trigger: input.type,
        classification: input.type.startsWith("build.") ? "material_change" : "review_outcome",
        evidence: { reason, fromStage: run.stage },
        chosenRoute: toStage,
        rejectedRoutes: null,
      };
      // The source run keeps its own history; the route lives on a new run so
      // the backtrack is visible rather than an edit of what was decided.
      terminalize("backtracked", reason || "routed back");
      const routed = createRun(draft, {
        projectId: input.projectId,
        kind: "stage",
        stage: toStage,
        state: "backtracked",
        sourceRunId: run.id,
      });
      draft.patch(routed, { routeTargetStage: toStage });
      return {
        runId: routed,
        stage: toStage,
        state: "backtracked",
        approval: approvalOf(input.type.endsWith("reject") ? "reject" : "revise"),
        flag,
      };
    }

    case "stage.select_route": {
      terminalize("routed", "route selected");
      const next = createRun(draft, {
        projectId: input.projectId,
        kind: "stage",
        stage: toStage,
        state: "in_progress",
        sourceRunId: run.id,
      });
      return { runId: next, stage: toStage, state: "in_progress" };
    }

    case "stage.fail":
    case "stage.cancel":
    case "build.fail":
    case "build.cancel":
    case "build.interrupt": {
      // The ledger row names the terminal state. Spelling it from the command
      // wrote "canceled", a state the ledger does not have, so a cancelled run
      // could neither be shown nor started again.
      const state = LEDGER.find((row) => row.id === args.transitionId)?.to?.state;
      if (!state) throw new HostError("internal_error", `No ledger row named ${args.transitionId}.`);
      terminalize(state, String(input.payload.reason ?? input.type));
      return { runId: run.id, stage: run.stage, state };
    }

    case "stage.retry":
    case "build.resume": {
      const source = draft.get(run.id);
      const next = createRun(draft, {
        projectId: input.projectId,
        kind: run.kind,
        stage: run.stage,
        state: run.kind === "build" ? "queued" : "in_progress",
        sourceRunId: run.id,
        packetId: source?.packetId ?? null,
        checkpointRef: source?.checkpointRef ?? null,
      });
      return {
        runId: next,
        stage: run.stage,
        state: run.kind === "build" ? "queued" : "in_progress",
      };
    }

    default:
      throw new HostError("internal_error", `No effect defined for ${input.type}.`);
  }
}
