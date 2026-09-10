/**
 * Installing the app into the workspace.
 *
 * The hub boots vanilla: migrate, mount, serve. Everything that makes it
 * *Solutions Builder* — the owner as a hub user with a tenant, the workflow
 * definitions generated from the ledger, the roles and grants, the specialist
 * prompts in the registry — is installed here, on the client's request, as
 * the owner, through the hub's API. First run and upgrade are the same call,
 * and it is idempotent, so the client can ask again whenever a credential
 * changes.
 *
 * "Installed" is a comparison, not a marker: every definition the package
 * generates exists in the tenant at the hash it would deploy right now.
 */
import { APP_VERSION } from "@solutions-builder/app/manifest";
import { agentFor } from "@solutions-builder/app/kit";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import {
  assignRole,
  createWorkspace,
  definitionIdFor,
  ensureOwner,
  ensureRole,
  ensureRoleGrant,
  forgetWorkspace,
  hubGet,
  hubMode,
  ownerPrincipalId,
  resolveWorkspace,
  type Workspace,
} from "./hub-client.js";
import { adoptLegacyWorkspace, bindAgentRole, deployDefinitionBodies } from "./hub-gaps.js";
import { expectedWorkflowDefinitions, seedWorkflows } from "./workflow-seed.js";

export type InstallState = {
  readonly installed: boolean;
  readonly appVersion: string;
  /** Definition names the tenant does not hold at all. */
  readonly missing: string[];
  /** Definition names the tenant holds at a different hash than the package generates. */
  readonly stale: string[];
  readonly detail: string;
};

const SPECIALIST = "specialist";

const ROLE_DESCRIPTIONS: Record<string, string> = {
  project_owner: "Opens a project, approves stages and accepts delivery.",
  budget_approver: "Approves a firm estimate before any spend is committed.",
  technical_approver: "Approves a plan on technical grounds.",
  audience_member: "Records a proceed, revise or reject on an audience package.",
  builder_operator: "Answers a build's questions and decides its permissions.",
  delivery_recipient: "Accepts or rejects the delivered software.",
  system: "The host acting on its own behalf; never a human decision.",
  [SPECIALIST]: "Drafts and proposes. Holds no approval, grant or waiver authority of any kind.",
};

export async function installState(): Promise<InstallState> {
  if (hubMode() !== "embedded") {
    // A hosted hub owns its tenants and definitions; installing into it is
    // that hub's lifecycle, not this process's.
    return {
      installed: true,
      appVersion: APP_VERSION,
      missing: [],
      stale: [],
      detail: "Hosted hub: definitions are managed there.",
    };
  }
  const expected = await expectedWorkflowDefinitions();
  if (!(await resolveWorkspace())) {
    return {
      installed: false,
      appVersion: APP_VERSION,
      missing: expected.map((entry) => entry.name),
      stale: [],
      detail: "No workspace yet.",
    };
  }
  const missing: string[] = [];
  const stale: string[] = [];
  for (const entry of expected) {
    const current = await definitionIdFor(entry.name);
    if (current === null) missing.push(entry.name);
    else if (current !== entry.id) stale.push(entry.name);
  }
  const installed = missing.length === 0 && stale.length === 0;
  return {
    installed,
    appVersion: APP_VERSION,
    missing,
    stale,
    detail: installed
      ? `Installed ${APP_VERSION}.`
      : missing.length > 0
        ? `${missing.length} definitions missing.`
        : `${stale.length} definitions out of date.`,
  };
}

/**
 * The owner as a hub user, in a tenant that is theirs. Creates neither twice.
 * A workspace from before the hub owned identity is adopted rather than
 * abandoned, so its projects keep their tenant.
 */
export async function ensureWorkspace(): Promise<Workspace | null> {
  if (hubMode() !== "embedded") return resolveWorkspace();
  await ensureOwner();
  const found = await resolveWorkspace();
  if (found) return found;
  // The owner exists but holds no tenant: a fresh install, or a legacy one.
  const me = await hubGet<{ id: string }>("/api/me");
  if (await adoptLegacyWorkspace(me.id)) {
    forgetWorkspace();
    const adopted = await resolveWorkspace();
    if (adopted) return adopted;
  }
  return createWorkspace();
}

/** Everything the tenant needs, in dependency order. Safe to run any time. */
export async function install(): Promise<InstallState> {
  if (hubMode() !== "embedded") return installState();

  await ensureWorkspace();
  const seeded = await seedWorkflows();

  // Authority is the platform's: the ledger's authorities become roles, the
  // owner holds every human one, and every stage definition is bound to
  // `specialist`, the role that approves nothing.
  const roles = new Map<string, string>();
  for (const name of [...AUTHORITIES, SPECIALIST]) {
    const role = await ensureRole(name, ROLE_DESCRIPTIONS[name] ?? "");
    roles.set(name, role.id);
  }
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    // Role membership becomes a real platform grant `@intx/authz` can answer
    // for, not a "role name equals authority name" assumption in a reader.
    await ensureRoleGrant({
      roleId: roles.get(name)!,
      resource: `authority:${name}`,
      action: "hold",
      effect: "allow",
      origin: "role",
    });
    await assignRole(ownerPrincipalId(), roles.get(name)!);
  }
  for (const entry of seeded) {
    if (entry.name.startsWith("solutions-builder.stage.")) {
      await bindAgentRole(entry.id, roles.get(SPECIALIST)!);
    }
  }

  // The prompt a specialist reads is a commit in the hub's own repo for that
  // definition, which is where a sidecar pulls it from.
  await deployDefinitionBodies(
    seeded
      .filter((entry) => /\.stage\.\d+$/.test(entry.name))
      .map((entry) => ({
        definitionId: entry.id,
        systemPrompt: agentFor(Number(entry.name.split(".").at(-1)) as never).system,
      })),
  );

  // Model bindings are the catalog rows written when a provider connects, so
  // there is nothing to rebind here; re-running after a credential change
  // exists so the definitions and roles are present for it to bind against.
  return installState();
}
