/**
 * Authority, in Interchange's own tables.
 *
 * The ledger's authorities are the roles this product recognises, and the
 * platform already models roles: `role` names them, `principal_role` says who
 * holds one, and `agent_role` binds a role to a workflow definition — the row
 * whose `agent_id` column holds a definition id, because in this revision an
 * agent *is* a deployed definition.
 *
 * Writing them here is the difference between referencing the platform's
 * authority and keeping a private copy of it. `builder.participant` still
 * records who plays which part on a given project, which the platform has no
 * concept of; what it no longer does is invent the vocabulary.
 *
 * The `specialist` role carries no approval authority, and that is its point:
 * every agent is bound to it, so "no agent gets human approval authority" is a
 * fact in the hub rather than a sentence in a prompt.
 */
import { and, eq } from "drizzle-orm";
import { hub } from "./hub-mount.js";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import { LOCAL_TENANT } from "./projects.js";

const SPECIALIST = "specialist";

const DESCRIPTIONS: Record<string, string> = {
  project_owner: "Opens a project, approves stages and accepts delivery.",
  budget_approver: "Approves a firm estimate before any spend is committed.",
  technical_approver: "Approves a plan on technical grounds.",
  audience_member: "Records a proceed, revise or reject on an audience package.",
  builder_operator: "Answers a build's questions and decides its permissions.",
  delivery_recipient: "Accepts or rejects the delivered software.",
  system: "The host acting on its own behalf; never a human decision.",
  [SPECIALIST]:
    "Drafts and proposes. Holds no approval, grant or waiver authority of any kind.",
};

type Col = never;
type Handle = {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
    };
  };
  insert: (table: unknown) => {
    values: (row: unknown) => { onConflictDoNothing: () => Promise<unknown> };
  };
};

/**
 * Creates the role vocabulary, grants it to the workspace owner, and binds
 * every seeded agent definition to `specialist`.
 *
 * Idempotent: ids are derived from the names, and the join rows are inserted
 * with `on conflict do nothing`, so re-seeding writes nothing new.
 */
export async function seedRoles(input: {
  ownerPrincipalId: string;
  agentDefinitionIds: readonly string[];
}): Promise<{ roles: number; held: number; bound: number }> {
  const schema = await import("@intx/db/schema");
  const { role, principalRole, agentRole, grant } = schema as unknown as {
    role: unknown;
    principalRole: unknown;
    agentRole: unknown;
    grant: unknown;
  };
  const db = hub().db.db as unknown as Handle;
  const roleColumns = role as unknown as { tenantId: Col; name: Col };

  const names = [...AUTHORITIES, SPECIALIST];
  const ids = new Map<string, string>();
  for (const name of names) {
    const [existing] = await db
      .select()
      .from(role)
      .where(and(eq(roleColumns.tenantId, LOCAL_TENANT), eq(roleColumns.name, name)));
    if (existing) {
      ids.set(name, String(existing.id));
      continue;
    }
    const id = `role_${name}`;
    await db
      .insert(role)
      .values({
        id,
        tenantId: LOCAL_TENANT,
        name,
        description: DESCRIPTIONS[name] ?? null,
        // System roles: this product defines them, an operator does not edit
        // them, and the ledger is where their meaning is written down.
        isSystem: true,
      })
      .onConflictDoNothing();
    ids.set(name, id);
  }

  // The grant that turns role membership into an authority a caller can ask
  // `@intx/authz` about: whoever holds this role gets an `allow` on
  // `authority:<name>/hold`, resolved through the same evaluator every other
  // platform grant goes through — not a private "role name === authority name"
  // assumption baked into the reader.
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    await db
      .insert(grant)
      .values({
        id: `grant_authority_${name}`,
        tenantId: LOCAL_TENANT,
        roleId: ids.get(name)!,
        resource: `authority:${name}`,
        action: "hold",
        effect: "allow",
        origin: "role",
      })
      .onConflictDoNothing();
  }

  // The owner of a single-user workspace holds every human authority. Written
  // as separate rows rather than one super-role, so an authority check reads
  // the same way here as it will when these are different people.
  let held = 0;
  for (const name of AUTHORITIES) {
    if (name === "system") continue;
    await db
      .insert(principalRole)
      .values({ principalId: input.ownerPrincipalId, roleId: ids.get(name)! })
      .onConflictDoNothing();
    held += 1;
  }

  let bound = 0;
  for (const definitionId of input.agentDefinitionIds) {
    await db
      .insert(agentRole)
      .values({ agentId: definitionId, roleId: ids.get(SPECIALIST)! })
      .onConflictDoNothing();
    bound += 1;
  }

  return { roles: ids.size, held, bound };
}
