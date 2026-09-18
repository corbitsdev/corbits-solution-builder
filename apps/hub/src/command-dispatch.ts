/**
 * Host command dispatch — the host's own effects on a project.
 *
 * A person's decision at a gate is not dispatched here. It is a named signal
 * the client delivers to the run over `/hub`; the hub authorizes it by grant,
 * the runtime deduplicates it by `signalId`, `admitGate` admits it inside the
 * run, and the ledger records it on read (`recordAdmittedGates`). What this
 * module runs is what only the host can do: write an artifact version (a
 * frozen packet, a delivery manifest), start or settle a build attempt,
 * answer a worker, archive or delete a project, and relay a draft round
 * (`deliverRound`) with the inference the specialist drafts with. It does not
 * move run state: that lives in the workflow definition.
 */
import type { Command, Stage } from "@solutions-builder/app/ledger";
import { classifyTarget, SELECTABLE_TARGETS } from "@solutions-builder/app/targets";
import { LEDGER, PROJECT_DELETE } from "@solutions-builder/app/ledger";
import { evaluate, evaluateAudienceDecision, type GuardContext, type RunView } from "@solutions-builder/app/guard";
import { HostError, notFound } from "./errors.js";
import { newId } from "./ids.js";
import { database, type Db } from "./db.js";
import type { Authority } from "@solutions-builder/app/ledger";
import { launchProjectLifecycle, projectExecutionStatus, type DeliveryOutcome } from "./lifecycle-run.js";
import { deliverRound, ROUND_COMMAND } from "./gate-delivery.js";
import { activeRun, readRun, runsForProject, type RunRecord } from "./runs.js";
import {
  authoritiesFor,
  versionHashesMatch,
  audienceTally,
  packetExists,
} from "./command-approvals.js";
import {
  recordCommand,
  receiptFor,
  audienceDecisions,
  openQuestion,
  ledgerCommands,
  type BuildAnswer,
  type BuildQuestion,
  type DecisionFlag,
  type RetentionReceipt,
} from "./command-ledger.js";
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
import { notifyDecision } from "./notify.js";
import { readProject, updateProject, type ProjectPolicy } from "./project-records.js";

export { requiredAuthorityFor, soloApprovalFor } from "./command-approvals.js";

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

export type { ProjectPolicy } from "./project-records.js";

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
   * What `deliverRound` did with the round this command relayed. Present only
   * for `stage.draft`; a caller that needs the round to have actually reached
   * a waiting run reads this rather than assuming delivery from a bare commit.
   */
  readonly delivery?: DeliveryOutcome;
};

type VersionRef = { artifactId: string; versionId: string; contentHash: string };

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

function viewFromCommands(
  runId: string,
  openingRunId: string,
  after: { state?: string; stage?: number } | undefined,
  statusStage: Stage | undefined,
): RunView {
  const stage = (statusStage ?? after?.stage ?? 1) as Stage;
  return {
    id: runId,
    kind: stage >= 8 ? "build" : "stage",
    stage,
    state: (after?.state ?? "in_progress") as RunView["state"],
    originId: openingRunId,
    routeTargetStage: null,
    costApprovalVersionId: null,
    checkpointRef: null,
  };
}

function toRunView(record: RunRecord): RunView {
  return {
    id: record.id,
    kind: record.kind,
    stage: record.stage,
    state: record.state,
    originId: record.originId,
    routeTargetStage: record.routeTargetStage,
    costApprovalVersionId: record.costApprovalVersionId,
    checkpointRef: record.checkpointRef,
  };
}

/** Scoped lookup: a run in another project is not found, not forbidden. */
async function loadRun(runId: string, projectId: string): Promise<RunView> {
  const record = await readRun(runId, projectId);
  if (!record) throw notFound("That run");
  return toRunView(record);
}

async function resolveRun(runId: string, projectId: string): Promise<RunView> {
  const commands = await ledgerCommands(projectId);
  const opening = commands.find((command) => command.command === "project.create");
  const openedId = (opening?.after as { runId?: string } | undefined)?.runId;
  const last = [...commands].reverse().find((command) => {
    const after = command.after as { runId?: string } | null;
    return typeof after?.runId === "string" && (after.runId === runId || after.runId === openedId);
  });
  const after = last?.after as { state?: string; stage?: number } | undefined;
  const status = await projectExecutionStatus(projectId);
  try {
    const loaded = await loadRun(runId, projectId);
    return {
      ...loaded,
      stage: status?.stage ?? loaded.stage,
      state: (after?.state ?? loaded.state) as RunView["state"],
    };
  } catch (cause) {
    if (openedId !== runId) throw cause;
    return viewFromCommands(runId, openedId, after, status?.stage);
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
  const run = await resolveRun(runId, input.projectId);
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

  const context: GuardContext = {
    actorAuthorities: authorities,
    ...(typeof input.payload.targetStage === "number" ? { targetStage: input.payload.targetStage as Stage } : {}),
    ...(needsExactVersions ? { versionHashesMatch: await versionHashesMatch(db, versions) } : {}),
    ...(input.type === "build.freeze" ? { frozenPacketExists: await packetExists(db, run.id) } : {}),
    ...(audienceGuard ? { audience: audienceGuard } : {}),
    ...(input.type === "build.answer" ? { waitingRequestOriginId: waiting?.originId ?? "" } : {}),
    // Checkpoint resume is verified only when a worker actually returned a
    // checkpoint it advertises as resumable. The bounded bridge returns none,
    // so resume is refused there rather than faked.
    ...(input.type === "build.resume" ? { checkpointResumeVerified: run.checkpointRef !== null } : {}),
  };

  const verdict =
    input.type === "audience.decide" ? evaluateAudienceDecision(run, context) : evaluate(input.type, run, context);
  if (!verdict.ok) throw new HostError("transition_refused", verdict.message, { refusal: verdict.code });
  const { transition, toStage } = verdict;

  const outcome = await db.transaction(async (tx) => {
    const applied = await apply(tx, {
      input,
      run,
      policy,
      versions,
      transitionId: transition.id,
      toStage,
      authority: authorities[0] ?? "project_owner",
      ...(waiting ? { openQuestionId: waiting.id } : {}),
    });

    const result: CommandOutcome = {
      runId: applied.runId,
      stage: applied.stage,
      state: applied.state,
      transitionId: transition.id,
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
    await writeArtifact(outcome.applied.artifact.draft, input.actor);
    // A manifest is checked the moment it exists, so the stage 9 decision
    // opens knowing what is missing rather than discovering it on accept.
    if (outcome.applied.artifact.verifyDelivery) {
      const version = await latestManifest(input.projectId);
      if (version) await verifyAndRecord(input.projectId, version, input.actor);
    }
  }

  // A draft round is relayed to the run after the guard allowed it, and
  // recorded here under the same key the signal carries, so the run's own
  // `SignalReceived` is one turn on the ledger, not two.
  const delivery = input.type === ROUND_COMMAND ? await deliverRound(input, run.stage) : undefined;

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
    ...(outcome.applied.flag ? { flag: outcome.applied.flag } : {}),
    ...(outcome.applied.question ? { question: outcome.applied.question } : {}),
    ...(outcome.applied.answer ? { answer: outcome.applied.answer } : {}),
    ...(outcome.applied.approval ?? {}),
  });

  if (outcome.applied.notifyRunId) {
    await notifyDecision(input.projectId, outcome.applied.notifyRunId).catch(() => undefined);
  }

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
  _tx: Tx,
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

  const approvalOf = (decision: string, audienceName?: string): AppliedApproval => ({
    decision,
    audienceName: audienceName ?? null,
    versions: args.versions,
    rationale: (input.payload.rationale as string | undefined) ?? null,
    assumptions: (input.payload.assumptions as unknown) ?? null,
  });

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
      // only durable effect is the round `deliverRound` relays to the run
      // after this command commits.
      return { runId: run.id, stage: run.stage, state: run.state };
    }

    case "stage.submit": {
      return { runId: run.id, stage: run.stage, state: "waiting_approval", notifyRunId: run.id };
    }

    case "stage.approve": {
      return { runId: run.id, stage: toStage, state: "in_progress", approval: approvalOf("approve") };
    }

    case "cost.approve": {
      return { runId: run.id, stage: 7, state: "cost_approved", approval: approvalOf("approve") };
    }

    case "build.freeze": {
      // The frozen packet is an artifact version of its own: the exact
      // versions it freezes are its sources, the freezing person its producer,
      // and the stage 7 run its producer run, which is what a second freeze
      // for the same source is refused against.
      const targets = Array.isArray(input.payload.targets) ? input.payload.targets.map(String) : [];
      // A target `classifyTarget` cannot place is a build nobody can verify:
      // refused here, at the freeze, rather than discovered later at the
      // verdict when it is too late to ask the person again.
      const unclassifiable = targets.filter((target) => classifyTarget(target) === "other");
      if (unclassifiable.length > 0) {
        throw new HostError(
          "validation_failed",
          `The build packet cannot be frozen: ${unclassifiable.map((target) => `"${target}"`).join(", ")} ${unclassifiable.length === 1 ? "is not a recognized target modality" : "are not recognized target modalities"}. Choose from: ${SELECTABLE_TARGETS.map((entry) => entry.target).join(", ")}.`,
        );
      }
      const packet = {
        versions: args.versions,
        placement: String(input.payload.placement ?? "local"),
        targets,
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
      return {
        runId: run.id,
        stage: 8,
        state: "queued",
        artifact: { draft: draftPacket },
      };
    }

    case "build.start_attempt": {
      if (run.state === "queued") {
        return { runId: run.id, stage: 8, state: "running" };
      }
      return { runId: run.id, stage: 8, state: "queued" };
    }

    case "build.wait_for_human": {
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
      return {
        runId: run.id,
        stage: 9,
        state: "delivery_review",
        approval: approvalOf("accept"),
        notifyRunId: run.id,
        artifact: { draft: draftManifest, verifyDelivery: true },
      };
    }

    case "delivery.accept": {
      // Acceptance is this command's own ledger turn; the manifest version
      // it accepts is unchanged.
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
      return {
        runId: run.id,
        stage: toStage,
        state: "backtracked",
        approval: approvalOf(input.type.endsWith("reject") ? "reject" : "revise"),
        flag,
      };
    }

    case "stage.select_route": {
      return { runId: run.id, stage: toStage, state: "in_progress" };
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
      return { runId: run.id, stage: run.stage, state };
    }

    case "stage.retry":
    case "build.resume": {
      return {
        runId: run.id,
        stage: run.stage,
        state: run.kind === "build" ? "queued" : "in_progress",
      };
    }

    default:
      throw new HostError("internal_error", `No effect defined for ${input.type}.`);
  }
}
