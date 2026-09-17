/**
 * Approval-adjacent guard inputs — the exact-version check, audience
 * tallying, solo-approver detection, and the stage-to-authority mapping.
 * Nothing here writes run state; it only reads what the guard needs to
 * decide.
 */
import { and, eq } from "drizzle-orm";
import type { Stage } from "@solutions-builder/app/ledger";
import type { Authority } from "@solutions-builder/app/ledger";
import * as table from "./schema.js";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import { evaluate, listPrincipals } from "./hub-client.js";
import { HOST_PRINCIPAL } from "./engine.js";
import type { Tx } from "./engine.js";
import { audienceDecisions } from "./engine-ledger.js";

export function requiredAuthorityFor(stage: number): Authority {
  if (stage === 7) return "budget_approver";
  if (stage === 6) return "technical_approver";
  if (stage === 9) return "delivery_recipient";
  return "project_owner";
}

/**
 * What this actor may do *on this project*.
 *
 * Single-tenant authorization invariant: a grant issued in tenant T
 * authorizes actions in T only. An ancestor tenant's grants — including the
 * workspace's — never authorize actions in a descendant project tenant, and
 * no general authorization path here walks the ancestor chain: evaluation is
 * scoped to the project tenant, and a workspace principal with no principal
 * in the project holds nothing. A compromised workbench must not inherit
 * authority over the projects under it. The one exception is the narrow
 * credential-use delegation (`credential:{id}` / `use`, resource-scoped),
 * resolved down the chain at credential source-resolution time; everything
 * else stays single-tenant.
 *
 * A project is a tenant, so the question is the hub's to answer: the actor's
 * principal in that tenant, and the `authority:<name>/hold` grants its roles
 * carry, evaluated by the hub's own grant evaluator. A workspace principal
 * that was never put on the project has no principal there and holds nothing.
 * `system` is the one exception — never a role a person holds, only the host
 * acting on its own behalf.
 */
export async function authoritiesFor(
  projectId: string,
  principalId: string,
): Promise<Authority[]> {
  if (principalId === HOST_PRINCIPAL) return ["system"];
  const inProject = await principalInProject(projectId, principalId);
  if (!inProject) return [];
  const held: Authority[] = [];
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    if ((await evaluate(inProject, `authority:${name}`, "hold", projectId)) === "allow") held.push(name);
  }
  return held;
}

/**
 * The actor's principal in the project tenant: the one referring to the same
 * user as their workspace principal. Nobody there means not on the project.
 */
async function principalInProject(projectId: string, principalId: string): Promise<string | null> {
  const [workspace, members] = await Promise.all([listPrincipals(), listPrincipals(projectId)]);
  const me = workspace.find((row) => row.id === principalId);
  if (!me) return null;
  return members.find((row) => row.kind === "user" && row.refId === me.refId)?.id ?? null;
}

/**
 * Whether `actorPrincipalId` is the only person who could approve this
 * stage on this project.
 *
 * "Submit for approval" is ceremony when the submitter and the approver are
 * the same human — a local, single-user workspace, today. This is what lets
 * the UI ask the one real question instead of a config flag: is there anyone
 * *else* in the project tenant holding the role this stage's approval
 * requires.
 */
export async function soloApprovalFor(
  projectId: string,
  stage: Stage,
  actorPrincipalId: string,
): Promise<boolean> {
  const required = requiredAuthorityFor(stage);
  const actor = await principalInProject(projectId, actorPrincipalId);
  const members = await listPrincipals(projectId);
  return !members.some(
    (row) =>
      row.id !== actor &&
      row.kind === "user" &&
      row.status === "active" &&
      row.roles.some((role) => role.name === required),
  );
}

type VersionRef = { artifactId: string; versionId: string; contentHash: string };

/**
 * The exact-version check. An approval names a version *and* the hash the
 * approver saw; if the stored node's hash differs, the draft moved and the
 * approval is refused rather than silently applied to newer bytes.
 */
export async function versionHashesMatch(db: { select: Tx["select"] }, versions: VersionRef[]): Promise<boolean> {
  if (versions.length === 0) return false;
  for (const reference of versions) {
    const [node] = await db
      .select({ hash: table.artifactNode.contentHash })
      .from(table.artifactNode)
      .where(eq(table.artifactNode.id, reference.versionId));
    if (!node || node.hash !== reference.contentHash) return false;
  }
  return true;
}

export async function audienceTally(
  projectId: string,
  runId: string,
  policy: { audienceQuorum: number },
) {
  const rows = await audienceDecisions(projectId, runId);
  return {
    required: policy.audienceQuorum,
    proceeded: rows.filter((row) => row.decision === "proceed").length,
    blocked: rows.filter((row) => row.decision !== "proceed").length,
  };
}

/**
 * Whether a build packet was already frozen from this source run. The packet
 * is an artifact version of kind build_packet whose producer is the source run.
 */
export async function packetExists(db: { select: Tx["select"] }, sourceRunId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: table.artifactNode.id })
    .from(table.artifactNode)
    .where(
      and(eq(table.artifactNode.kind, "build_packet"), eq(table.artifactNode.producerRunId, sourceRunId)),
    );
  return Boolean(row);
}
