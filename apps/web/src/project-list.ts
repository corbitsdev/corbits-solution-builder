/**
 * Project list: tenants under the workspace tenant, read straight off the
 * hub -- no host DB read.
 *
 * Name and created date come off the project's own tenant row
 * (`listProjectRecords`, folded from the caller's own memberships over
 * `GET /api/me/principals`, the same as workbench). Where each stands is the
 * project workflow's own stage (CL-8687/CL-8721) -- `displayStage` reads it
 * per card, never derived from the artifact graph. `needsDecision` is "a
 * stock hub approval is pending on one of this project's stage specialists"
 * and `turn` stays `"idle"` — telling whether the specialist is mid-draft
 * would mean polling every project's mailbox on every list refresh, which
 * this list does not do. Specialists deploy into the WORKSPACE tenant, so
 * approvals are read from there and matched back to this project via
 * `listSpecialistDeployments` (same as `decisions-fold.ts`).
 */
import type { Transport } from "@intx/hub-client";
import { listProjectRecords, listSpecialistDeployments, resolveWorkspace } from "@solutions-builder/installer";
import type { ProjectSummary } from "./client.ts";
import { createHubTransport } from "./hub.ts";
import { pendingApprovals } from "./pending-approvals.ts";
import { workspaceGuidance } from "./pages/workspace/guidance.ts";
import type { ChatMessage } from "./stage-mail.ts";

const workflowStageCache = new Map<string, { stage: number; done: boolean; at: number }>();
// 5s — the same cadence `app.tsx`'s own `refresh()` polls the project list
// at, so a card remounted (returning from the workspace after an approval)
// never reads a cached stage that is already stale by the time the list
// itself refreshes.
const WORKFLOW_STAGE_CACHE_MS = 5_000;

/**
 * A project card's displayed stage (CL-8687): the project workflow's own
 * `stage`, read-only -- never deploys the workflow just to show a card, and
 * never a guessed stage when the read fails. Cached per project for
 * `WORKFLOW_STAGE_CACHE_MS` so a list of many cards costs at most one read
 * per project per refresh window, not one per render. `displayDone` reads
 * the same cache entry, so a caller that calls this first gets `done` for
 * free (CL-8723: stage 9's `approve` decision is what actually finishes a
 * project — the card should say so, not just "Stage 9 of 9"). Returns null
 * when the workflow could not be read -- the caller shows "Status
 * unavailable" with a Retry, never a stage number.
 */
export async function displayStage(
  projectId: string,
  readView: (projectId: string) => Promise<{ stage: number; done: boolean } | null>,
): Promise<number | null> {
  const cached = workflowStageCache.get(projectId);
  if (cached && Date.now() - cached.at < WORKFLOW_STAGE_CACHE_MS) return cached.stage;
  const view = await readView(projectId).catch(() => null);
  if (!view) return null;
  workflowStageCache.set(projectId, { stage: view.stage, done: view.done, at: Date.now() });
  return view.stage;
}

/** Whether the project workflow has finished, per the last `displayStage`
 *  read for this project — false until `displayStage` has run at least
 *  once, which every caller does before this (`ProjectCard`'s own effect). */
export function displayDone(projectId: string): boolean {
  return workflowStageCache.get(projectId)?.done ?? false;
}

const turnCache = new Map<string, { label: string | null; at: number }>();
const TURN_CACHE_MS = 5_000;

/**
 * Whose turn a project card is on, read off its current stage's mail thread
 * alone (CL-8725) -- never a readiness verdict, the same restraint
 * `workspaceGuidance` itself keeps. `hasPendingApproval` is the project-wide
 * signal `listProjectSummaries` already folds as `needsDecision`; a caller
 * showing both only ever surfaces one of the two.
 */
export function turnLabel(stage: number, messages: readonly ChatMessage[], hasPendingApproval: boolean): string | null {
  if (hasPendingApproval) return "Waiting on a decision";
  const guidance = workspaceGuidance(stage, messages);
  if (guidance.question) return "Your turn · a question is waiting";
  if (guidance.draft) return "Your turn · ready for your approval";
  const last = messages.at(-1);
  if (last && last.author === "me") return "Specialist working";
  return null;
}

export type TurnDeps = {
  stageAgentStatus: (projectId: string, stage: number) => Promise<{ address: string } | null>;
  readStageThread: (tenantId: string, addresses: string[]) => Promise<ChatMessage[]>;
  workspaceTenantId: () => Promise<string | null>;
};

/**
 * `turnLabel` for one project card, cached for `TURN_CACHE_MS` per
 * project+stage so a grid of many cards costs at most one mail-thread read
 * per project per refresh window. Never called for an archived project or
 * for any stage but the current one -- the caller's job, not this one's.
 */
export async function displayTurn(
  projectId: string,
  stage: number,
  hasPendingApproval: boolean,
  deps: TurnDeps,
): Promise<string | null> {
  const key = `${projectId}:${stage}`;
  const cached = turnCache.get(key);
  if (cached && Date.now() - cached.at < TURN_CACHE_MS) return cached.label;
  const tenantId = await deps.workspaceTenantId();
  const status = tenantId ? await deps.stageAgentStatus(projectId, stage).catch(() => null) : null;
  const messages = status && tenantId ? await deps.readStageThread(tenantId, [status.address]).catch(() => []) : [];
  const label = turnLabel(stage, messages, hasPendingApproval);
  turnCache.set(key, { label, at: Date.now() });
  return label;
}

/**
 * Every project tenant under the workspace. `stage` is always null here --
 * the project workflow is the only authority on it, and reading every
 * project's workflow just to list cards would mean one read per project on
 * every list refresh; `displayStage` reads it per card instead.
 */
export async function listProjectSummaries(transport: Transport = createHubTransport()): Promise<ProjectSummary[]> {
  const workspace = await resolveWorkspace(transport);
  if (!workspace) return [];
  const records = await listProjectRecords(transport, workspace.tenantId);
  const pending = (await pendingApprovals(workspace.tenantId, transport).catch(() => [])).filter(
    (approval) => approval.status === "pending",
  );
  return Promise.all(
    records.map(async (record): Promise<ProjectSummary> => {
      const deployments = await listSpecialistDeployments(transport, workspace.tenantId, record.id).catch(() => []);
      const deploymentIds = new Set(deployments.map((deployment) => deployment.deploymentId));
      const needsDecision = pending.some((approval) => deploymentIds.has(approval.anchorRunId));
      return {
        id: record.id,
        revision: record.revision,
        title: record.title,
        stage: null,
        archivedAt: record.archivedAt ? record.archivedAt.toISOString() : null,
        needsDecision,
        waits: [],
        turn: "idle",
      };
    }),
  );
}
