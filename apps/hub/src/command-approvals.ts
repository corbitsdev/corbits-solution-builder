/**
 * Approval-adjacent guard inputs: solo-approver detection, and the
 * stage-to-authority mapping. Nothing here writes run state; it only reads
 * what the guard needs to decide.
 */
import type { Stage } from "@solutions-builder/app/ledger";
import type { Authority } from "@solutions-builder/app/ledger";
import { listPrincipals } from "./hub-client.js";

export function requiredAuthorityFor(stage: number): Authority {
  if (stage === 7) return "budget_approver";
  if (stage === 6) return "technical_approver";
  if (stage === 9) return "delivery_recipient";
  return "project_owner";
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

