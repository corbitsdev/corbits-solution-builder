/**
 * The bell's Activity (#834): one row per project and stage with unread
 * agent replies, read from every active project's own mailbox.
 *
 * The legacy un-scoped `/api/me/inbox` resolved one arbitrary principal
 * across every tenant, so the bell showed one project's replies as bare run
 * addresses and never the others'. Replies are filed to the person's
 * principal in each project's tenant (or the workspace's, for a specialist
 * deployed before #29), so this reads each tenant a project's specialists run
 * in and maps a sender back to its stage by deployment id — a specialist's
 * address is `<deploymentId>@<domain>` (`listSpecialistDeployments`).
 *
 * Only stage specialists count. Decision notices already sit under the
 * bell's "Needs you"; the evaluator, the product guide and a review panel
 * reply to the app, never into a chat the person reads. A project whose
 * read fails is reported as such rather than dropped (#570): an empty row
 * would read as "nothing new".
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, listSpecialistDeployments, resolveWorkspace } from "@solutions-builder/installer";
import { createHubTransport } from "./hub.ts";

export type ActivityRow = {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly stage: number;
  /** Unread replies in this stage, at most one page's worth (`PAGE_LIMIT`). */
  readonly count: number;
  /** When the newest unread reply landed. */
  readonly latestAt: string;
};

export type ActivityFailure = {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly message: string;
};

export type ActivityState = {
  /** Newest reply first. */
  readonly rows: ActivityRow[];
  readonly failures: ActivityFailure[];
  /** Every unread reply across `rows`. */
  readonly unreadCount: number;
};

export const EMPTY_ACTIVITY: ActivityState = { rows: [], failures: [], unreadCount: 0 };

export type InboxRow = {
  readonly uid: number;
  readonly flags: readonly string[];
  readonly envelope: { readonly from: string; readonly date: string };
};

export type ActivityDeps = {
  /** Active projects only — an archived one has no Activity. */
  readonly listProjects: () => Promise<readonly { id: string; title: string }[]>;
  readonly listDeployments: (projectId: string) => Promise<readonly { stage: number; deploymentId: string; tenantId: string }[]>;
  /** The newest page of one tenant's INBOX. */
  readonly readInbox: (tenantId: string) => Promise<readonly InboxRow[]>;
};

/** One page per mailbox per read: the bell is a summary, and once replies
 * are marked read as they are viewed, far fewer than this are ever unread. */
const PAGE_LIMIT = 100;
const SEEN_FLAG = "\\Seen";

function senderLocalPart(from: string): string {
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

/**
 * Pure: the unread rows from one project's mailboxes, folded by stage. A
 * sender outside `stageByDeploymentId` (a decision notice, a reviewer, a
 * person) is not a reply and does not count.
 */
export function groupUnreadReplies(
  project: { readonly id: string; readonly title: string },
  rows: readonly InboxRow[],
  stageByDeploymentId: ReadonlyMap<string, number>,
): ActivityRow[] {
  const byStage = new Map<number, { count: number; latestAt: string }>();
  for (const row of rows) {
    if (row.flags.includes(SEEN_FLAG)) continue;
    const stage = stageByDeploymentId.get(senderLocalPart(row.envelope.from));
    if (stage === undefined) continue;
    const held = byStage.get(stage);
    if (!held) byStage.set(stage, { count: 1, latestAt: row.envelope.date });
    else {
      held.count += 1;
      if (Date.parse(row.envelope.date) > Date.parse(held.latestAt)) held.latestAt = row.envelope.date;
    }
  }
  return [...byStage.entries()].map(([stage, { count, latestAt }]) => ({
    projectId: project.id,
    projectTitle: project.title,
    stage,
    count,
    latestAt,
  }));
}

/** Activity over `deps`: one deployments read and one inbox page per tenant
 * per project, a tenant shared by several projects (the workspace, for
 * projects older than #29) read once. */
export async function foldActivity(deps: ActivityDeps): Promise<ActivityState> {
  const projects = await deps.listProjects();
  const inboxByTenant = new Map<string, Promise<readonly InboxRow[]>>();
  const inboxOf = (tenantId: string) => {
    let read = inboxByTenant.get(tenantId);
    if (!read) {
      read = deps.readInbox(tenantId);
      inboxByTenant.set(tenantId, read);
    }
    return read;
  };
  const rows: ActivityRow[] = [];
  const failures: ActivityFailure[] = [];
  await Promise.all(
    projects.map(async (project) => {
      try {
        const deployments = await deps.listDeployments(project.id);
        const stageByDeploymentId = new Map(deployments.map((deployment) => [deployment.deploymentId.toLowerCase(), deployment.stage]));
        const tenantIds = [...new Set(deployments.map((deployment) => deployment.tenantId))];
        const pages = await Promise.all(tenantIds.map(inboxOf));
        rows.push(...groupUnreadReplies(project, pages.flat(), stageByDeploymentId));
      } catch (cause) {
        failures.push({ projectId: project.id, projectTitle: project.title, message: cause instanceof Error ? cause.message : String(cause) });
      }
    }),
  );
  rows.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
  failures.sort((a, b) => a.projectTitle.localeCompare(b.projectTitle));
  return { rows, failures, unreadCount: rows.reduce((total, row) => total + row.count, 0) };
}

export function activityDeps(transport: Transport): ActivityDeps {
  return {
    listProjects: async () => {
      const workspace = await resolveWorkspace(transport);
      if (!workspace) return [];
      return (await listProjectRecords(transport, workspace.tenantId))
        .filter((record) => record.archivedAt === null)
        .map((record) => ({ id: record.id, title: record.title || record.id }));
    },
    listDeployments: (projectId) => listSpecialistDeployments(transport, projectId),
    readInbox: async (tenantId) => {
      const page = await transport.fetch<{ messages: InboxRow[] }>(
        "GET",
        `/api/tenants/${encodeURIComponent(tenantId)}/mailbox/me/inbox?folder=INBOX&limit=${String(PAGE_LIMIT)}`,
      );
      return page.messages;
    },
  };
}

/** The bell's Activity off the hub. Throws only when the project list
 * itself cannot be read; a single project's failure is in `failures`. */
export function readActivity(transport: Transport = createHubTransport()): Promise<ActivityState> {
  return foldActivity(activityDeps(transport));
}
