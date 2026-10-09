import { describe, expect, test } from "bun:test";
import { foldActivity, groupUnreadReplies, type ActivityDeps, type InboxRow } from "./activity.ts";

const SEEN = "\\Seen";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 12, minute)).toISOString();

function row(uid: number, from: string, minute: number, flags: string[] = []): InboxRow {
  return { uid, flags, envelope: { from, date: at(minute) } };
}

const RECIPES = { id: "prj_recipes", title: "Recipe Sharing" };
const STAGES = new Map([
  ["run_discovery", 1],
  ["run_shape", 2],
]);

describe("groupUnreadReplies", () => {
  test("one row per stage with unread replies, counted, dated by the newest", () => {
    const rows = [
      row(1, "run_discovery@sb-recipes.localhost", 1),
      row(2, "run_discovery@sb-recipes.localhost", 5),
      row(3, "Solution shape <run_shape@sb-recipes.localhost>", 3),
    ];
    expect(groupUnreadReplies(RECIPES, rows, STAGES)).toEqual([
      { projectId: "prj_recipes", projectTitle: "Recipe Sharing", stage: 1, count: 2, latestAt: at(5) },
      { projectId: "prj_recipes", projectTitle: "Recipe Sharing", stage: 2, count: 1, latestAt: at(3) },
    ]);
  });

  test("a read reply, a decision notice and mail from a person do not count", () => {
    const rows = [
      row(1, "run_discovery@sb-recipes.localhost", 1, [SEEN]),
      row(2, "owner@sb-workspace.localhost", 2),
      row(3, "run_unknown_reviewer@sb-recipes.localhost", 3),
    ];
    expect(groupUnreadReplies(RECIPES, rows, STAGES)).toEqual([]);
  });

  test("the sender is matched case-insensitively on its deployment id", () => {
    expect(groupUnreadReplies(RECIPES, [row(1, "RUN_DISCOVERY@SB-Recipes.localhost", 1)], STAGES)).toHaveLength(1);
  });
});

describe("foldActivity", () => {
  const projects = [
    { id: "prj_recipes", title: "Recipe Sharing" },
    { id: "prj_legacy", title: "Older project" },
  ];
  function deps(overrides: Partial<ActivityDeps> = {}): ActivityDeps & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      listProjects: async () => projects,
      listDeployments: async (projectId) =>
        projectId === "prj_recipes"
          ? [{ stage: 1, deploymentId: "run_discovery", tenantId: "prj_recipes" }]
          : [
              { stage: 1, deploymentId: "run_old1", tenantId: "tnt_workspace" },
              { stage: 2, deploymentId: "run_old2", tenantId: "tnt_workspace" },
            ],
      readInbox: async (tenantId) => {
        reads.push(tenantId);
        if (tenantId === "prj_recipes") return [row(1, "run_discovery@sb-recipes.localhost", 9)];
        return [row(4, "run_old2@sb-workspace.localhost", 2), row(5, "owner@sb-workspace.localhost", 8)];
      },
      ...overrides,
    };
  }

  test("reads each project's own mailboxes and sorts rows newest first", async () => {
    const d = deps();
    const state = await foldActivity(d);
    expect(state.rows.map((entry) => [entry.projectTitle, entry.stage, entry.count])).toEqual([
      ["Recipe Sharing", 1, 1],
      ["Older project", 2, 1],
    ]);
    expect(state.unreadCount).toBe(2);
    expect(state.failures).toEqual([]);
    // The workspace mailbox is read once, however many legacy deployments name it.
    expect(d.reads.sort()).toEqual(["prj_recipes", "tnt_workspace"]);
  });

  test("one project's failed read is reported, not dropped, and the others still show", async () => {
    const state = await foldActivity(
      deps({
        readInbox: async (tenantId) => {
          if (tenantId === "tnt_workspace") throw new Error("HTTP 502");
          return [row(1, "run_discovery@sb-recipes.localhost", 9)];
        },
      }),
    );
    expect(state.rows.map((entry) => entry.projectTitle)).toEqual(["Recipe Sharing"]);
    expect(state.failures).toEqual([{ projectId: "prj_legacy", projectTitle: "Older project", message: "HTTP 502" }]);
  });

  test("a project with no specialist yet reads no mailbox", async () => {
    const d = deps({ listDeployments: async () => [] });
    const state = await foldActivity(d);
    expect(state.rows).toEqual([]);
    expect(d.reads).toEqual([]);
  });
});
