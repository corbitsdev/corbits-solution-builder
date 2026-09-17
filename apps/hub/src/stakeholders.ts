/**
 * The stakeholders of a project: the people a stage-5 package is written for
 * and who each record a decision on it. The ledger calls them audiences —
 * `audience.decide`, `audienceQuorum` — and that name stays in the record;
 * the interface says stakeholders, which is what a person means.
 *
 * They live in the project's policy, which is what the rendered lifecycle
 * reads to give stage 5 one package step per stakeholder. So a change here
 * is three things: the policy, the roles the hub holds for them, and the
 * executor forgetting the deployment it resolved, since the next command has
 * to render the lifecycle again with the new list.
 */
import { AUTHORITIES, type Authority } from "@solutions-builder/app/ledger";
import { HostError } from "./errors.js";
import { forgetExecution } from "./hub-executor.js";
import { installProjectAuthority } from "./project-authority.js";
import { requireProject, updateProject, type ProjectPolicy } from "./project-records.js";

export type Stakeholder = { name: string; role: Authority };

/** The roles a stakeholder may hold; `system` is the host's, never a person's. */
export const STAKEHOLDER_ROLES: readonly Authority[] = AUTHORITIES.filter((role) => role !== "system");

const MAX_NAME = 80;

/** Checks the list before anything is written, and says what is wrong in the person's terms. */
export function validateStakeholders(input: { audiences: unknown; audienceQuorum: unknown }): {
  audiences: Stakeholder[];
  audienceQuorum: number;
} {
  if (!Array.isArray(input.audiences)) throw new HostError("validation_failed", "Stakeholders must be a list.");
  const audiences: Stakeholder[] = [];
  for (const raw of input.audiences as unknown[]) {
    const entry = raw as { name?: unknown; role?: unknown };
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length === 0) throw new HostError("validation_failed", "Every stakeholder needs a name.");
    if (name.length > MAX_NAME) throw new HostError("validation_failed", `${name.slice(0, 20)}… is too long a name; ${MAX_NAME} characters at most.`);
    if (audiences.some((held) => held.name.toLowerCase() === name.toLowerCase())) {
      throw new HostError("validation_failed", `${name} is listed twice.`);
    }
    const role = entry.role as Authority;
    if (!STAKEHOLDER_ROLES.includes(role)) {
      throw new HostError("validation_failed", `${name} has a role this project does not know: ${String(entry.role)}.`);
    }
    audiences.push({ name, role });
  }
  if (audiences.length === 0) throw new HostError("validation_failed", "A project needs at least one stakeholder.");
  const quorum = Number(input.audienceQuorum);
  if (!Number.isInteger(quorum) || quorum < 0 || quorum > audiences.length) {
    throw new HostError("validation_failed", `The quorum must be a whole number from 0 to ${audiences.length}.`);
  }
  return { audiences, audienceQuorum: quorum };
}

/** Replaces the project's stakeholders and quorum, and makes the change reach the run. */
export async function setStakeholders(
  projectId: string,
  input: { audiences: unknown; audienceQuorum: unknown },
): Promise<ProjectPolicy> {
  const checked = validateStakeholders(input);
  const project = await requireProject(projectId);
  const policy: ProjectPolicy = { ...project.policy, audiences: checked.audiences, audienceQuorum: checked.audienceQuorum };
  const updated = await updateProject(projectId, { policy });
  // Roles for the new names; the ones already there are left as they were.
  await installProjectAuthority(projectId, policy);
  // The lifecycle was rendered for the old list. The next command renders
  // it again and brings the fresh run to where the ledger stands.
  forgetExecution(projectId);
  return updated.policy;
}
