/**
 * Stakeholders can be changed while a project is under way.
 *
 * The people stage 5 writes for live in the project's policy. Replacing the
 * list updates the policy and the quorum, installs a role for each new name,
 * and is what the next draft renders one package per. What is refused is
 * refused before anything is written, in the person's terms.
 *
 * Usage: bun --conditions intx-src scripts/stakeholders-smoke.ts
 */
import { givenDataDir } from "./smoke-env.js";
import { openDatabase } from "../apps/hub/src/db.js";
import { prepareDatabase } from "../apps/hub/src/migrate.js";
import { ensureHub, localActor, listRoles } from "../apps/hub/src/hub-client.js";
import { install } from "./host-install.js";
import { createProject } from "../apps/hub/src/projects.js";
import { readProject } from "../apps/hub/src/project-records.js";
import { audienceRoleName } from "@solutions-builder/installer";
import { setStakeholders, validateStakeholders, STAKEHOLDER_ROLES } from "../apps/hub/src/stakeholders.js";
import { HostError } from "../apps/hub/src/errors.js";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}

const host = await openDatabase(
  givenDataDir ? `${givenDataDir}/pglite-stakeholders` : undefined,
);
await prepareDatabase(host);
await ensureHub();
await install();
const ACTOR = { ...localActor(), displayName: "Stakeholders smoke" };

const created = await createProject({
  title: "Stakeholders smoke",
  owner: ACTOR,
  policy: { costTolerancePercent: 10, costToleranceAbsolute: 100, audiences: [{ name: "You", role: "project_owner" }], audienceQuorum: 1, allowExternalProviders: true },
});

check("the roles a stakeholder may hold never include the host's", !STAKEHOLDER_ROLES.includes("system" as never) && STAKEHOLDER_ROLES.includes("audience_member"));

const policy = await setStakeholders(created.projectId, {
  audiences: [
    { name: "You", role: "project_owner" },
    { name: "Dana (finance)", role: "budget_approver" },
    { name: "The ops team", role: "audience_member" },
  ],
  audienceQuorum: 2,
});
check("the policy holds the new list and quorum", policy.audiences.length === 3 && policy.audienceQuorum === 2, policy.audiences.map((a) => a.name).join(", "));
const stored = await readProject(created.projectId);
check("the change is what the project reads back", stored?.policy.audiences.length === 3 && stored.policy.audienceQuorum === 2);
check("the revision moved, so a stale client is caught", (stored?.revision ?? 0) > 1, String(stored?.revision));
const roles = await listRoles(created.projectId);
check("each new stakeholder has a role in the project", ["Dana (finance)", "The ops team"].every((name) => roles.some((role) => role.name === audienceRoleName(name))), roles.map((role) => role.name).filter((n) => n.startsWith("audience:")).join(", "));

const refused = (input: { audiences: unknown; audienceQuorum: unknown }) => {
  try {
    validateStakeholders(input);
    return null;
  } catch (cause) {
    return cause instanceof HostError ? cause.message : String(cause);
  }
};
check("a blank name is refused", refused({ audiences: [{ name: " ", role: "audience_member" }], audienceQuorum: 0 })?.includes("needs a name") === true);
check("a name listed twice, however spelled, is refused by name", /dana is listed twice/i.test(refused({ audiences: [{ name: "Dana", role: "audience_member" }, { name: "dana", role: "budget_approver" }], audienceQuorum: 0 }) ?? ""));
check("a role the project does not know is refused", refused({ audiences: [{ name: "Dana", role: "ceo" }], audienceQuorum: 0 })?.includes("ceo") === true);
check("the host's own role is refused for a person", refused({ audiences: [{ name: "Dana", role: "system" }], audienceQuorum: 0 }) !== null);
check("a quorum past the list is refused", refused({ audiences: [{ name: "Dana", role: "audience_member" }], audienceQuorum: 2 })?.includes("0 to 1") === true);
check("an empty list is refused", refused({ audiences: [], audienceQuorum: 0 })?.includes("at least one") === true);

const failed = checks.filter((entry) => !entry.ok);
console.log(`\nStakeholders smoke: ${checks.length - failed.length}/${checks.length} checks passed`);
await host.close();
process.exit(failed.length === 0 ? 0 : 1);
