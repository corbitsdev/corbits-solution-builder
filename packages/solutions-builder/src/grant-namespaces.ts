/**
 * The grant-namespace convention shared across Corbits apps.
 *
 * Multiple apps share one Interchange backing. Client-minted grants only stay
 * collision-free if every app respects the same naming convention — otherwise
 * two apps mint overlapping names and silent ambient authority returns with
 * extra steps. This module is where the convention lives so it is read, not
 * remembered: the app package is installed into every Interchange tenant, so
 * every app reads this file. Anything that mints or declares a grant checks
 * it first; a mint outside the minter's own namespace is refused.
 *
 * The rule: a grant resource names its namespace first — `authority:` for the
 * hub's role grants, `<domain>.` for capability grants — and only the app that
 * owns a namespace may mint under it. An unknown prefix mints for nobody; add
 * it to the table below first, with its owner and meaning.
 *
 * Prefix ownership:
 *
 * - `authority:` — owned by solutions-builder. `authority:<name>` with action
 *   `hold` means the role holds the ledger human authority `<name>`
 *   (`project_owner`, `budget_approver`, `technical_approver`,
 *   `audience_member`, `builder_operator`, `delivery_recipient`). Minted only
 *   by the hub installer (`install.ts`, `project-tenant.ts`) through
 *   `ensureRoleGrant`. `system` is never minted: the host acts as system, it
 *   does not grant it. Audience roles (`audience:<name>`) are roles and carry
 *   no grant. Nothing declares `authority:` as a requirement; the evaluator
 *   answers it from role grants.
 * - `artifact.` — versioned artifacts: read a released version, propose a
 *   draft, write a draft real. `signal.` — supervision signals an agent may
 *   propose but only a human sends. `plan.` — build-plan validation.
 *   `policy.` — cost-policy reads for estimates. `feedback.` — design-feedback
 *   proposals. `packet.` — freezing the build packet a worker executes.
 *   `provider.` — provider-connection management (tenant scope).
 *   `credential.` — credential metadata, never secrets (tenant scope).
 *   `sink.` — verifying delivered bytes against the manifest. All owned by
 *   solutions-builder and reserved: no deployed tool exercises them and the
 *   kit declares none of them as a requirement today, so nothing mints or
 *   materializes them. They stay in the table so no other app claims the
 *   prefix.
 * - `conversation.` — appending to the project conversation. `workflow.` —
 *   reading workflow definitions. `workflow-run:` — a run the hub signals.
 *   The installer mints `workflow-run:*` with action `signal:<awaiter>` from
 *   the ledger onto each human authority role so a role without that
 *   command cannot deliver the signal; the platform also mints manage/read
 *   on specific run ids. `approval:` — a tool call parked on a stock hub
 *   approval (`vendor/interchange/packages/hub-api/src/routes/approvals.ts`).
 *   The installer mints `approval:*` with action `resolve` onto the
 *   authorities the ledger names for stage 9's delivery decision
 *   (`delivery.accept`/`.reject`/`.revise`), the one gate that is an
 *   approval rather than a named signal (CL-8566). `mail.` — sending mail
 *   through sessions. `events.` — reading run events. `conversation.`,
 *   `workflow.`, `mail.` and `events.` stay platform-minted.
 *   `workflow-run:` and `approval:` are the platform resources the
 *   installer writes itself, because those grants have to exist before any
 *   run does.
 *
 * Grandfathered, not a precedent: the one-time legacy adoption in
 * `hub-migrate.ts` (`adoptLegacyWorkspace`) writes a `*`/`*` owner grant with
 * origin `system` to link a pre-identity workspace. It predates this
 * convention, runs once, and no new mint may use `*`.
 */

export const SOLUTIONS_BUILDER_APP = "solutions-builder";
export const INTERCHANGE_APP = "interchange";

export type GrantNamespaceEntry = {
  /** The prefix a resource must start with to fall under this namespace. */
  readonly prefix: string;
  /** The app that owns the namespace. */
  readonly owner: string;
  /** Apps allowed to mint (create grant rows or per-run materializations). */
  readonly mintedBy: readonly string[];
  /** Apps allowed to declare the grant as a requirement without minting it. */
  readonly requiredBy: readonly string[];
  /** What a grant name under this namespace means. */
  readonly meaning: string;
};

const BUILDER = SOLUTIONS_BUILDER_APP;
const PLATFORM = INTERCHANGE_APP;

export const GRANT_NAMESPACES: readonly GrantNamespaceEntry[] = [
  {
    prefix: "authority:",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning:
      "Authority roles: `authority:<ledger-authority>` with action `hold` means the role holds that human authority. Minted only by the hub installer; nothing declares it in practice, but mint-implies-require keeps the table honest about the enforced rule.",
  },
  {
    prefix: "artifact.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning:
      "Versioned artifacts: read a released version, propose a draft, write a draft real. Writing never shares a role with deciding.",
  },
  {
    prefix: "signal.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Supervision signals an agent may propose; only a human decision sends one.",
  },
  {
    prefix: "plan.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Build-plan validation against approved inputs.",
  },
  {
    prefix: "policy.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Cost-policy reads for reproducible estimates. Never spend.",
  },
  {
    prefix: "feedback.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Design-feedback proposals on a deliverable.",
  },
  {
    prefix: "packet.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Freezing the build packet a worker executes.",
  },
  {
    prefix: "provider.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Provider-connection management, tenant scope.",
  },
  {
    prefix: "credential.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Credential metadata, tenant scope. The secret itself is never granted.",
  },
  {
    prefix: "sink.",
    owner: BUILDER,
    mintedBy: [BUILDER],
    requiredBy: [BUILDER],
    meaning: "Verifying delivered bytes against the manifest.",
  },
  {
    prefix: "conversation.",
    owner: PLATFORM,
    mintedBy: [PLATFORM],
    requiredBy: [BUILDER, PLATFORM],
    meaning: "Appending to the project conversation. Owned by the platform; apps require, never mint.",
  },
  {
    prefix: "workflow-run:",
    owner: PLATFORM,
    mintedBy: [BUILDER, PLATFORM],
    requiredBy: [BUILDER, PLATFORM],
    meaning:
      "A workflow run. `workflow-run:*` with action `signal:<awaiter>` means the role may deliver that named signal on any run in the tenant. Minted by the installer from the ledger onto each human authority; the platform also mints manage/read on specific run ids.",
  },
  {
    prefix: "workflow.",
    owner: PLATFORM,
    mintedBy: [PLATFORM],
    requiredBy: [BUILDER, PLATFORM],
    meaning: "Reading workflow definitions. Owned by the platform; apps require, never mint.",
  },
  {
    prefix: "approval:",
    owner: PLATFORM,
    mintedBy: [BUILDER, PLATFORM],
    requiredBy: [BUILDER, PLATFORM],
    meaning:
      "A tool call parked on a stock hub approval. `approval:*` with action `resolve` means the role may list and resolve any pending approval in the tenant. Minted by the installer onto the authorities the ledger names for stage 9's delivery decision; the platform also mints manage/read where it needs to.",
  },
  {
    prefix: "mail.",
    owner: PLATFORM,
    mintedBy: [PLATFORM],
    requiredBy: [BUILDER, PLATFORM],
    meaning: "Sending mail through sessions. Owned by the platform; apps require, never mint.",
  },
  {
    prefix: "events.",
    owner: PLATFORM,
    mintedBy: [PLATFORM],
    requiredBy: [BUILDER, PLATFORM],
    meaning: "Reading run events. Owned by the platform; apps require, never mint.",
  },
];

/** The convention entry a resource falls under, or undefined when namespaced nowhere.
 *  Longest prefix wins so `workflow-run:` is not swallowed by `workflow.`. */
export function grantNamespaceOf(resource: string): GrantNamespaceEntry | undefined {
  let best: GrantNamespaceEntry | undefined;
  for (const entry of GRANT_NAMESPACES) {
    if (!resource.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best;
}

function refusal(verb: string, app: string, resource: string): Error {
  const entry = grantNamespaceOf(resource);
  const owner = entry ? ` owned by ${entry.owner}` : " with no owning app";
  return new Error(
    `${app} may not ${verb} grant "${resource}": namespace${owner} (see grant-namespaces.ts).`,
  );
}

/**
 * Refuses a mint outside the minter's own namespace. Call it wherever a grant
 * row or per-run materialization is created, before any write.
 */
export function assertMayMintGrant(app: string, resource: string): void {
  const entry = grantNamespaceOf(resource);
  if (!entry || !entry.mintedBy.includes(app)) throw refusal("mint", app, resource);
}

/**
 * Refuses a requirement declaration the declaring app may not even ask for.
 * Weaker than minting: an app may require a platform namespace it uses (with
 * `source: "invoker"`), but never another app's namespace and never an
 * unknown one.
 */
export function assertMayRequireGrant(app: string, resource: string): void {
  const entry = grantNamespaceOf(resource);
  if (!entry || (!entry.mintedBy.includes(app) && !entry.requiredBy.includes(app))) {
    throw refusal("require", app, resource);
  }
}
