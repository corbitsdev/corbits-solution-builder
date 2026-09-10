/**
 * The command engine — BUILD_PLAN_V3 sections 6, 7 and 11.
 *
 * One entry point for every state change. It:
 *   1. dedupes on the envelope's idempotency key (at-least-once is assumed);
 *   2. resolves the actor's real authorities from the platform (`hub/authority.ts`);
 *   3. asks the guard whether the ledger permits the command;
 *   4. commits the state change, its audit row and its outbox row together;
 *   5. opens or closes the durable human wait, *before* any notification.
 *
 * Step 4 is why this is one module and not several: the atomicity claim is only
 * true if there is a single place that writes.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Command, Stage } from "@solutions-builder/app/ledger";
import { PROJECT_DELETE } from "@solutions-builder/app/ledger";
import { evaluate, evaluateAudienceDecision, type GuardContext, type RunView } from "./guard.js";
import { HostError, notFound } from "./errors.js";
import { newId, sha256 } from "./ids.js";
import { database, type Db } from "./db.js";
import * as table from "./schema.js";
import type { Authority } from "@solutions-builder/app/ledger";
import {
  activeRunRecord,
  getRunRecord,
  launchProjectLifecycle,
  putRunRecord,
  updateRunRecord,
} from "./hub-executor.js";
import { loadRun } from "./engine-views.js";
import {
  authoritiesFor,
  versionHashesMatch,
  audienceTally,
  packetExists,
  waitingOrigin,
} from "./engine-approvals.js";
import { audit, enqueue } from "./engine-audit.js";
import { runGateSideEffects } from "./engine-recovery.js";

export { requiredAuthorityFor, soloApprovalFor } from "./engine-approvals.js";

/**
 * Launches a project's `project-lifecycle` run in the runtime executor. Called
 * once, right after `store/projects.ts` commits the project and its first
 * run — outside any transaction, since the executor is not something the
 * database's single writer connection can be reached from mid-transaction.
 */
export async function launchProjectRun(args: {
  readonly projectId: string;
  readonly branchId: string;
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

export type ProjectPolicy = {
  costTolerancePercent: number;
  costToleranceAbsolute: number;
  audiences: { name: string; role: Authority }[];
  audienceQuorum: number;
  allowExternalProviders: boolean;
};

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
};

type VersionRef = { artifactId: string; versionId: string; contentHash: string };

function createRun(args: {
  projectId: string;
  branchId: string;
  kind: "stage" | "build";
  stage: Stage;
  state: string;
  sourceRunId?: string | null;
  packetId?: string | null;
  checkpointRef?: string | null;
}): string {
  const id = newId.run();
  putRunRecord({
    id,
    projectId: args.projectId,
    branchId: args.branchId,
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
  return id;
}

/**
 * Rebuilds a project's run from what is durable.
 *
 * Run state lives in the runtime, in memory, so a restart loses it — and a
 * project the person can see but not open is a worse answer than any position
 * we might recover. The artifacts and approvals are durable, and between them
 * they say where the work got to: the furthest stage that produced something,
 * and whether that stage is waiting on a decision.
 *
 * Deliberately not a guess about the middle of a stage. It recovers the stage
 * and whether it is waiting, which is what every screen needs; the
 * conversation on that stage is durable too and comes back with it.
 */
/** The gates that leave a run parked on a person, by the command that parked it. */
const PARKED_BY: Record<string, { state: RunView["state"]; stage: Stage }> = {
  "stage.submit": { state: "waiting_approval", stage: 1 },
  "cost.approve": { state: "cost_approved", stage: 7 },
  "build.wait_for_human": { state: "waiting_human", stage: 8 },
  "build.accept_evidence": { state: "delivery_review", stage: 9 },
};

export async function rehydrateRun(projectId: string) {
  const { db } = database();
  const [project] = await db
    .select()
    .from(table.project)
    .where(and(eq(table.project.id, projectId), isNull(table.project.deletedAt)));
  if (!project) return undefined;

  const nodes = await db
    .select({ stage: table.artifactNode.stage })
    .from(table.artifactNode)
    .where(eq(table.artifactNode.projectId, projectId));
  const reached = nodes.reduce<number>((high, row) => Math.max(high, row.stage), 1) as Stage;

  // Whether the stage was waiting on a person is read from the last committed
  // command: the gates that park a run are the only ones that leave it there.
  // A stopgap until the parked run itself is durable through the platform.
  const [last] = await db
    .select({ command: table.auditEvent.command })
    .from(table.auditEvent)
    .where(and(eq(table.auditEvent.projectId, projectId), eq(table.auditEvent.outcome, "committed")))
    .orderBy(desc(table.auditEvent.createdAt))
    .limit(1);
  const parked = last ? PARKED_BY[last.command] : undefined;

  const now = new Date();
  const runId = newId.run();
  const record = {
    id: runId,
    projectId,
    branchId: project.activeBranchId ?? "",
    kind: "stage" as const,
    stage: parked ? Math.max(reached, parked.stage) as Stage : reached,
    state: (parked?.state ?? "in_progress") as RunView["state"],
    sourceRunId: null,
    originId: runId,
    terminalReason: null,
    costApprovalVersionId: null,
    routeTargetStage: null,
    packetId: null,
    checkpointRef: null,
    createdAt: now,
    endedAt: null,
  };
  putRunRecord(record);
  return record;
}

export async function execute(input: CommandInput): Promise<CommandOutcome> {
  const { db } = database();

  const replayed = await receiptFor(db, input.idempotencyKey);
  if (replayed) return replayed;

  try {
    return await runCommand(input);
  } catch (cause) {
    // The retry that lost the race: the winner has already committed, so the
    // refusal it just got is the wrong answer to give back.
    const settled = await receiptFor(db, input.idempotencyKey);
    if (settled) return settled;
    throw cause;
  }
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
  const before = getRunRecord(input.runId);
  if (!before || before.projectId !== input.projectId) throw notFound("That run");

  const submitted = await execute({
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
    payload: {
      runId: submitted.runId,
      versions: input.versions,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.forecastUsd !== undefined ? { forecastUsd: input.forecastUsd } : {}),
      ...(input.assumptions !== undefined ? { assumptions: input.assumptions } : {}),
    },
  });
}

async function runCommand(input: CommandInput): Promise<CommandOutcome> {
  const { db } = database();
  // Resolved before the transaction opens: the platform's grant tables live
  // on a separate connection binding than `tx`, and pglite is single-writer —
  // querying them from inside an open `db.transaction` callback deadlocks
  // against that same transaction rather than reading through it.
  const authorities = await authoritiesFor(input.projectId, input.actor.principalId);
  const outcome = await db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(table.project)
      .where(and(eq(table.project.id, input.projectId), isNull(table.project.deletedAt)));
    if (!project) throw notFound("That project");

    // §6: optimistic concurrency on the project. Two people looking at the
    // same stage, one of them acting on what the other has already changed,
    // is the case this exists for — and the failure is silent without it,
    // because both commands are individually legal.
    if (input.expectedRevision !== undefined && input.expectedRevision !== project.revision) {
      throw new HostError(
        "conflict",
        `This project has changed since you loaded it (revision ${project.revision}, you had ${input.expectedRevision}). Reload and decide again.`,
        { expected: input.expectedRevision, current: project.revision },
      );
    }

    const policy = project.policy as ProjectPolicy;

    // `project.delete` acts on the project, not on a run, so it never reaches
    // the run guard. Its authority and effects come from `PROJECT_DELETE`, and
    // "tombstone" means exactly that: the rows stay, the project stops being
    // readable. Nothing here removes what a person wrote.
    if (input.type === "project.delete") {
      const authorised = PROJECT_DELETE.authority.some((role) => authorities.includes(role));
      if (!authorised) {
        throw new HostError(
          "not_authorized",
          `Deleting a project is ${PROJECT_DELETE.authority.join(" or ")}'s decision.`,
        );
      }
      const deletedAt = new Date();
      await tx
        .update(table.project)
        .set({ deletedAt, revision: sql`${table.project.revision} + 1` })
        .where(eq(table.project.id, input.projectId));
      const open = activeRunRecord(input.projectId);
      await audit(tx, {
        projectId: input.projectId,
        actorPrincipalId: input.actor.principalId,
        authority: PROJECT_DELETE.authority[0],
        command: input.type,
        transitionId: "project.delete",
        correlationId: input.correlationId,
        before: { deletedAt: null },
        after: { deletedAt: deletedAt.toISOString(), effects: PROJECT_DELETE.effects },
        outcome: "committed",
      });
      const result: CommandOutcome = {
        runId: open?.id ?? "",
        stage: (open?.stage ?? 1) as Stage,
        state: (open?.state ?? "in_progress") as CommandOutcome["state"],
        transitionId: "project.delete",
        replayed: false,
      };
      await tx.insert(table.commandReceipt).values({
        idempotencyKey: input.idempotencyKey,
        commandType: input.type,
        result,
      });
      return result;
    }

    const runId = String(input.payload.runId ?? "");
    if (!runId) throw new HostError("validation_failed", "The command must name a run.");
    const run = loadRun(runId, input.projectId);

    const versions = Array.isArray(input.payload.versions)
      ? (input.payload.versions as VersionRef[])
      : [];
    const needsExactVersions = (
      ["stage.approve", "cost.approve", "build.freeze", "audience.decide"] as string[]
    ).includes(input.type);

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
      ...(input.type === "stage.approve" && run.stage === 5
        ? { audience: await audienceTally(tx, run.id, policy) }
        : {}),
      ...(input.type === "build.answer"
        ? { waitingRequestOriginId: (await waitingOrigin(tx, run.id)) ?? "" }
        : {}),
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
      await audit(tx, {
        projectId: input.projectId,
        actorPrincipalId: input.actor.principalId,
        authority: authorities[0] ?? null,
        command: input.type,
        transitionId: null,
        correlationId: input.correlationId,
        before: { runId: run.id, state: run.state, stage: run.stage },
        after: null,
        outcome: `refused:${verdict.code}`,
      });
      throw new HostError("transition_refused", verdict.message, { refusal: verdict.code });
    }

    const applied = await apply(tx, {
      input,
      run,
      policy,
      versions,
      branchId: project.activeBranchId ?? "",
      transitionId: verdict.transition.id,
      toStage: verdict.toStage,
      authority: authorities[0] ?? "project_owner",
    });

    await audit(tx, {
      projectId: input.projectId,
      actorPrincipalId: input.actor.principalId,
      authority: authorities[0] ?? null,
      command: input.type,
      transitionId: verdict.transition.id,
      correlationId: input.correlationId,
      before: { runId: run.id, state: run.state, stage: run.stage },
      after: { runId: applied.runId, state: applied.state, stage: applied.stage },
      outcome: "committed",
    });
    await enqueue(
      tx,
      `run.${verdict.transition.id}`,
      { projectId: input.projectId, runId: applied.runId, state: applied.state },
      input.correlationId,
    );

    const result: CommandOutcome = {
      runId: applied.runId,
      stage: applied.stage,
      state: applied.state,
      transitionId: verdict.transition.id,
      replayed: false,
    };
    // The project moves on with every command that commits, which is what
    // makes the expected-revision check above mean anything: a revision that
    // only changed on archive could never catch a stale decision.
    await tx
      .update(table.project)
      .set({ revision: sql`${table.project.revision} + 1` })
      .where(eq(table.project.id, input.projectId));

    await tx.insert(table.commandReceipt).values({
      idempotencyKey: input.idempotencyKey,
      commandType: input.type,
      result,
    });
    return result;
  });

  // Outside the transaction — the executor is not something the database's
  // single writer connection can be reached from mid-transaction, and this is
  // a best-effort shadow of the transition, not part of what made it valid.
  await runGateSideEffects(input);

  return outcome;
}

/**
 * The first result recorded under an idempotency key, if there is one.
 *
 * Checked before the transaction and again after one fails: a retry that
 * arrives while the original is still in flight cannot see the receipt on
 * either side of the guard, so it is the *failure* that has to be re-read as a
 * replay. Without that second look the loser of the race gets the guard's
 * refusal — `wrong_state` against a row the winner has already moved — instead
 * of the first call's result.
 */
async function receiptFor(
  runner: Db | Tx,
  idempotencyKey: string,
): Promise<CommandOutcome | null> {
  const [receipt] = await runner
    .select()
    .from(table.commandReceipt)
    .where(eq(table.commandReceipt.idempotencyKey, idempotencyKey));
  return receipt ? { ...(receipt.result as CommandOutcome), replayed: true } : null;
}

/**
 * The durable effects of an allowed transition. Everything here runs inside the
 * caller's transaction; nothing here re-checks a rule the guard already owns.
 */
async function apply(
  tx: Tx,
  args: {
    input: CommandInput;
    run: RunView;
    policy: ProjectPolicy;
    versions: VersionRef[];
    branchId: string;
    transitionId: string;
    toStage: Stage;
    authority: Authority;
  },
): Promise<{ runId: string; stage: Stage; state: string }> {
  const { input, run, toStage } = args;
  const branchId = args.branchId || run.id;
  const now = new Date();

  /**
   * The run is parked on a person from here. The parked run is the record;
   * this queues the ping, delivered after the transaction commits.
   */
  const announce = (runId: string) =>
    enqueue(tx, "decision.opened", { projectId: input.projectId, runId }, input.correlationId);

  const recordApproval = async (decision: string, audienceName?: string) => {
    await tx.insert(table.approvalRecord).values({
      id: newId.approval(),
      projectId: input.projectId,
      runId: run.id,
      stage: run.stage,
      command: input.type,
      decision,
      actorPrincipalId: input.actor.principalId,
      authority: args.authority,
      audienceName: audienceName ?? null,
      versions: args.versions,
      rationale: (input.payload.rationale as string | undefined) ?? null,
      assumptions: (input.payload.assumptions as unknown) ?? null,
      policyVersion: 1,
    });
  };

  const terminalize = (state: string, reason: string) => {
    updateRunRecord(run.id, { state: state as RunView["state"], terminalReason: reason, endedAt: now });
  };

  switch (input.type) {
    case "audience.decide": {
      const audienceName = String(input.payload.audienceName ?? "");
      const [already] = await tx
        .select({ id: table.approvalRecord.id })
        .from(table.approvalRecord)
        .where(
          and(
            eq(table.approvalRecord.runId, run.id),
            eq(table.approvalRecord.audienceName, audienceName),
          ),
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
      await recordApproval(
        String(input.payload.decision ?? "proceed"),
        String(input.payload.audienceName ?? ""),
      );
      // Record-only: the run does not move, by design.
      return { runId: run.id, stage: run.stage, state: run.state };
    }

    case "stage.submit": {
      updateRunRecord(run.id, { state: "waiting_approval" });
      await announce(run.id);
      return { runId: run.id, stage: run.stage, state: "waiting_approval" };
    }

    case "stage.approve": {
      await recordApproval("approve");
      terminalize("approved", "approved and advanced");
      const next = createRun({
        projectId: input.projectId,
        branchId,
        kind: "stage",
        stage: toStage,
        state: "in_progress",
        sourceRunId: run.id,
      });
      return { runId: next, stage: toStage, state: "in_progress" };
    }

    case "cost.approve": {
      await recordApproval("approve");
      // No stage advance. The cost approval is a field on this run, and
      // build.freeze is the only thing that reads it.
      updateRunRecord(run.id, {
        state: "cost_approved",
        costApprovalVersionId: args.versions[0]?.versionId ?? null,
      });
      return { runId: run.id, stage: 7, state: "cost_approved" };
    }

    case "build.freeze": {
      const packetId = newId.packet();
      const packetBody = JSON.stringify({
        versions: args.versions,
        placement: input.payload.placement,
        targets: input.payload.targets,
        costApprovalVersionId: run.costApprovalVersionId,
      });
      await tx.insert(table.buildPacket).values({
        id: packetId,
        projectId: input.projectId,
        sourceRunId: run.id,
        versions: args.versions,
        costApproval: { versionId: run.costApprovalVersionId },
        placement: String(input.payload.placement ?? "local"),
        targets: (input.payload.targets as unknown) ?? [],
        packetHash: await sha256(packetBody),
      });
      // Stage 7 is terminal from here. It never returns to in_progress;
      // a material change re-enters through stage.backtracked routing.
      terminalize("approved_frozen", "packet frozen");
      const buildRun = createRun({
        projectId: input.projectId,
        branchId,
        kind: "build",
        stage: 8,
        state: "queued",
        sourceRunId: run.id,
        packetId,
      });
      return { runId: buildRun, stage: 8, state: "queued" };
    }

    case "build.start_attempt": {
      if (run.state === "queued") {
        updateRunRecord(run.id, { state: "running" });
        return { runId: run.id, stage: 8, state: "running" };
      }
      // From a terminal build run: a new queued run linked to the unchanged source.
      const source = getRunRecord(run.id);
      const next = createRun({
        projectId: input.projectId,
        branchId,
        kind: "build",
        stage: 8,
        state: "queued",
        sourceRunId: run.id,
        packetId: source?.packetId ?? null,
      });
      return { runId: next, stage: 8, state: "queued" };
    }

    case "build.wait_for_human": {
      updateRunRecord(run.id, { state: "waiting_human" });
      await tx.insert(table.buildQuestion).values({
        id: newId.question(),
        projectId: input.projectId,
        runId: run.id,
        originId: run.originId,
        kind: String(input.payload.kind ?? "question"),
        prompt: String(input.payload.prompt ?? ""),
        scopeImpact: (input.payload.scopeImpact as unknown) ?? null,
      });
      await announce(run.id);
      return { runId: run.id, stage: 8, state: "waiting_human" };
    }

    case "build.answer": {
      await tx
        .update(table.buildQuestion)
        .set({
          answeredAt: now,
          answer: String(input.payload.answer ?? ""),
          answeredBy: input.actor.principalId,
          grantedCapabilities: (input.payload.grantedCapabilities as unknown) ?? null,
        })
        .where(
          and(eq(table.buildQuestion.runId, run.id), isNull(table.buildQuestion.answeredAt)),
        );
      // The same queued-origin attempt resumes. No new run, no origin change.
      updateRunRecord(run.id, { state: "running" });
      return { runId: run.id, stage: 8, state: "running" };
    }

    case "build.accept_evidence": {
      await recordApproval("accept");
      terminalize("evidence_accepted", "evidence accepted");
      const manifestBody = JSON.stringify(input.payload.descriptors ?? []);
      await tx.insert(table.deliveryManifest).values({
        id: newId.manifest(),
        projectId: input.projectId,
        buildRunId: run.id,
        descriptors: (input.payload.descriptors as unknown) ?? [],
        verification: (input.payload.verification as unknown) ?? {},
        actualCost: (input.payload.actualCost as unknown) ?? null,
        exceptions: (input.payload.exceptions as unknown) ?? null,
        manifestHash: await sha256(manifestBody),
      });
      const delivery = createRun({
        projectId: input.projectId,
        branchId,
        kind: "stage",
        stage: 9,
        state: "delivery_review",
        sourceRunId: run.id,
      });
      await announce(delivery);
      return { runId: delivery, stage: 9, state: "delivery_review" };
    }

    case "delivery.accept": {
      await recordApproval("accept");
      await tx
        .update(table.deliveryManifest)
        .set({ acceptedAt: now, acceptedBy: input.actor.principalId })
        .where(eq(table.deliveryManifest.projectId, input.projectId));
      terminalize("delivered", "accepted by the recipient");
      return { runId: run.id, stage: 9, state: "delivered" };
    }

    case "project.archive": {
      await tx
        .update(table.project)
        .set({ archivedAt: now, revision: sql`${table.project.revision} + 1` })
        .where(eq(table.project.id, input.projectId));
      return { runId: run.id, stage: run.stage, state: "archived" };
    }

    case "stage.reject":
    case "stage.revise":
    case "stage.route_back":
    case "delivery.reject":
    case "delivery.revise":
    case "build.route_material_change": {
      const reason = String(input.payload.reason ?? "");
      await recordApproval(input.type.endsWith("reject") ? "reject" : "revise");
      await tx.insert(table.decisionFlag).values({
        id: newId.flag(),
        projectId: input.projectId,
        runId: run.id,
        trigger: input.type,
        classification: input.type.startsWith("build.") ? "material_change" : "review_outcome",
        evidence: { reason, fromStage: run.stage },
        chosenRoute: toStage,
      });
      // The source run keeps its own history; the route lives on a new run so
      // the backtrack is visible rather than an edit of what was decided.
      terminalize("backtracked", reason || "routed back");
      const routed = createRun({
        projectId: input.projectId,
        branchId,
        kind: "stage",
        stage: toStage,
        state: "backtracked",
        sourceRunId: run.id,
      });
      updateRunRecord(routed, { routeTargetStage: toStage });
      return { runId: routed, stage: toStage, state: "backtracked" };
    }

    case "stage.select_route": {
      terminalize("routed", "route selected");
      const next = createRun({
        projectId: input.projectId,
        branchId,
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
      const state = input.type.split(".")[1] === "interrupt" ? "interrupted" : `${input.type.split(".")[1]}ed`;
      terminalize(state, String(input.payload.reason ?? input.type));
      return { runId: run.id, stage: run.stage, state };
    }

    case "stage.retry":
    case "build.resume": {
      const source = getRunRecord(run.id);
      const next = createRun({
        projectId: input.projectId,
        branchId,
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
