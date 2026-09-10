/**
 * Approval-adjacent guard inputs — the exact-version check, audience
 * tallying, solo-approver detection, and the stage-to-authority mapping.
 * Nothing here writes run state; it only reads what the guard needs to
 * decide.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Stage } from "@solutions-builder/app/ledger";
import type { Authority } from "@solutions-builder/app/ledger";
import { database } from "./db.js";
import * as table from "./schema.js";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import { evaluate } from "./hub-client.js";
import { HOST_PRINCIPAL } from "./engine.js";
import type { Tx } from "./engine.js";

export function requiredAuthorityFor(stage: number): Authority {
  if (stage === 7) return "budget_approver";
  if (stage === 6) return "technical_approver";
  if (stage === 9) return "delivery_recipient";
  return "project_owner";
}

/**
 * The actor's ledger authorities, resolved by the platform: `role` and
 * `principal_role` rows (seeded by `hub/roles.ts`), evaluated through
 * `@intx/authz` in `hub/authority.ts`. `system` is the one exception — it is
 * never a role a principal holds, only the host process acting on its own
 * behalf.
 */
/**
 * What this actor may do *on this project*.
 *
 * Two questions, and both have to be asked. The platform answers the first —
 * does this principal hold `budget_approver` at all — through its own grant
 * evaluator. `builder.participant` answers the second: is that a part they
 * play here. Interchange's `principal_role` is tenant-wide and has no concept
 * of a project, so asking only the platform would let someone approve a
 * budget on a project they were never put on. Asking only the participant
 * table is what this code did before the platform owned authority at all.
 */
export async function authoritiesFor(
  projectId: string,
  principalId: string,
): Promise<Authority[]> {
  if (principalId === HOST_PRINCIPAL) return ["system"];

  const granted = await heldAuthorities(principalId);
  const { db } = database();
  const parts = await db
    .select({ role: table.participant.role })
    .from(table.participant)
    .where(
      and(
        eq(table.participant.projectId, projectId),
        eq(table.participant.principalId, principalId),
      ),
    );
  const onThisProject = new Set(parts.map((row) => row.role));
  return granted.filter((name) => onThisProject.has(name));
}

/**
 * Whether `actorPrincipalId` is the only person who could approve this
 * stage on this project.
 *
 * "Submit for approval" is ceremony when the submitter and the approver are
 * the same human — a local, single-user workspace, today. This is what lets
 * the UI ask the one real question instead of a config flag: is there
 * anyone *else* on this project who actually holds the authority this
 * stage's approval requires, through the same platform grant `authoritiesFor`
 * already resolves for every command. A participant row alone is not
 * enough — someone added to a project without the platform grant does not
 * make the workspace multi-approver.
 */
export async function soloApprovalFor(
  projectId: string,
  stage: Stage,
  actorPrincipalId: string,
): Promise<boolean> {
  const required = requiredAuthorityFor(stage);
  const { db } = database();
  const rows = await db
    .select({ principalId: table.participant.principalId })
    .from(table.participant)
    .where(and(eq(table.participant.projectId, projectId), eq(table.participant.role, required)));
  const others = [...new Set(rows.map((row) => row.principalId))].filter(
    (principalId) => principalId !== actorPrincipalId,
  );
  for (const candidate of others) {
    const held = await authoritiesFor(projectId, candidate);
    if (held.includes(required)) return false;
  }
  return true;
}

type VersionRef = { artifactId: string; versionId: string; contentHash: string };

/**
 * The exact-version check. An approval names a version *and* the hash the
 * approver saw; if the stored node's hash differs, the draft moved and the
 * approval is refused rather than silently applied to newer bytes.
 */
export async function versionHashesMatch(tx: Tx, versions: VersionRef[]): Promise<boolean> {
  if (versions.length === 0) return false;
  for (const reference of versions) {
    const [node] = await tx
      .select({ hash: table.artifactNode.contentHash })
      .from(table.artifactNode)
      .where(eq(table.artifactNode.id, reference.versionId));
    if (!node || node.hash !== reference.contentHash) return false;
  }
  return true;
}

export async function audienceTally(tx: Tx, runId: string, policy: { audienceQuorum: number }) {
  const rows = await tx
    .select({ decision: table.approvalRecord.decision })
    .from(table.approvalRecord)
    .where(
      and(eq(table.approvalRecord.runId, runId), eq(table.approvalRecord.command, "audience.decide")),
    );
  return {
    required: policy.audienceQuorum,
    proceeded: rows.filter((row) => row.decision === "proceed").length,
    blocked: rows.filter((row) => row.decision !== "proceed").length,
  };
}

export async function packetExists(tx: Tx, sourceRunId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: table.buildPacket.id })
    .from(table.buildPacket)
    .where(eq(table.buildPacket.sourceRunId, sourceRunId));
  return Boolean(row);
}

export async function waitingOrigin(tx: Tx, runId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ originId: table.buildQuestion.originId })
    .from(table.buildQuestion)
    .where(and(eq(table.buildQuestion.runId, runId), isNull(table.buildQuestion.answeredAt)))
    .orderBy(desc(table.buildQuestion.createdAt))
    .limit(1);
  return row?.originId;
}

/**
 * The ledger authorities a principal holds, per the hub's own grant evaluator:
 * install stamps each role with `allow` on `authority:<name>/hold`, so holding
 * one is a platform fact the hub answers for, not a name this file assumes.
 * `system` is never held by a person; it is the host's own authority.
 */
async function heldAuthorities(principalId: string): Promise<Authority[]> {
  const held: Authority[] = [];
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    if ((await evaluate(principalId, `authority:${name}`, "hold")) === "allow") held.push(name);
  }
  return held;
}
