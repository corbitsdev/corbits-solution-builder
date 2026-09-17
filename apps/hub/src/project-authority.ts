/**
 * Ledger authorities as roles on a project tenant.
 *
 * Named-signal grants (`workflow-run:*` / `signal:<name>`) stay the
 * installer's: this only ensures the roles a person holds and the
 * `authority:<name>/hold` grant the evaluator answers for, plus one role
 * per audience. Used when the hub changes stakeholders on a project the
 * installer already opened.
 */
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import { HostError } from "./errors.js";
import { assignRole, ensureRole, ensureRoleGrant, myPrincipalIn } from "./hub-client.js";
import type { ProjectPolicy } from "./project-records.js";

const ROLE_DESCRIPTIONS: Record<string, string> = {
  project_owner: "Opens a project, approves stages and accepts delivery.",
  budget_approver: "Approves a firm estimate before any spend is committed.",
  technical_approver: "Approves a plan on technical grounds.",
  audience_member: "Records a proceed, revise or reject on an audience package.",
  builder_operator: "Answers a build's questions and decides its permissions.",
  delivery_recipient: "Accepts or rejects the delivered software.",
};

export function audienceRoleName(audience: string): string {
  return `audience:${audience}`;
}

export async function installProjectAuthority(projectId: string, policy: ProjectPolicy): Promise<void> {
  const owner = await myPrincipalIn(projectId);
  if (!owner) {
    throw new HostError("internal_error", "The hub opened the project but the owner is not in it.");
  }
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    const role = await ensureRole(name, ROLE_DESCRIPTIONS[name] ?? "", projectId);
    await ensureRoleGrant(
      {
        roleId: role.id,
        resource: `authority:${name}`,
        action: "hold",
        effect: "allow",
        origin: "role",
      },
      projectId,
    );
    await assignRole(owner, role.id, projectId);
  }
  for (const audience of policy.audiences) {
    const role = await ensureRole(
      audienceRoleName(audience.name),
      `Audience "${audience.name}" on this project.`,
      projectId,
    );
    await assignRole(owner, role.id, projectId);
  }
}
