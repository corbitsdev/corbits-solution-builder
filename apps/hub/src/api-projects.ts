import type { Hono } from "hono";
import { ProjectCreatePayload } from "./domain.js";
import { HostError } from "./errors.js";
import { openDecisions } from "./decisions.js";
import {
  artifactGraph,
  createProject,
  listProjects,
  projectDetail,
  readArtifactNode,
  renameProject,
  archiveProject,
  deleteProject,
} from "./projects.js";
import {
  designHistory,
  feedbackFor,
  submitFeedback,
  type Direction,
} from "./design-feedback.js";
import { redesignFromFeedback } from "./agent-run.js";
import { appendHumanTurn } from "./hub-conversation.js";
import { nameProject, titleFromProblem } from "./title.js";
import { runGuidance } from "./guide.js";
import { notFound } from "./errors.js";
import { type RunState } from "@solutions-builder/app/ledger";
import { parsed } from "./api.js";
import { localActor } from "./hub-client.js";

export function registerProjectRoutes(api: Hono) {
  api.get("/decisions", async (context) =>
    context.json({ decisions: await openDecisions() }),
  );

  api.get("/projects", async (context) => context.json({ projects: await listProjects() }));

  api.post("/projects", async (context) => {
    const payload = parsed(ProjectCreatePayload(await context.req.json()));
    const problem = payload.problemStatement?.trim() ?? "";

    // Opened with the plain first line so a project exists whether or not a
    // model is reachable; the real name follows below.
    const created = await createProject({
      title: payload.title || titleFromProblem(problem),
      policy: payload.policy,
      owner: localActor(),
    });

    if (problem.length > 0) {
      // What they typed IS the first thing they said. It used to be accepted
      // and dropped — the signature took it, nothing wrote it — so stage 1
      // opened by asking for the problem they had just described.
      // Not best effort. What somebody typed is the thing this project is
      // about, and a `.catch` that logs is precisely how it went missing
      // before — the write failed, a line went to a console nobody reads, and
      // stage 1 asked for the problem again as if they had never spoken. If
      // this cannot be recorded the create fails and says so, because a
      // project that has forgotten its own problem is worse than no project.
      await appendHumanTurn({
        projectId: created.projectId,
        branchId: created.branchId,
        runId: created.runId,
        stage: 1,
        body: problem,
        actor: localActor(),
      });

      // A name for the thing, not a sentence about the person. Best effort and
      // never blocking: a project that will not open because a model is busy
      // is a far worse failure than a plainly-named one.
      await nameProject(problem)
        .then((name) => renameProject(created.projectId, name))
        .catch((cause: unknown) => {
          console.error("[projects] the project kept its opening name:", cause);
        });
    }

    return context.json(created, 201);
  });

  api.get("/projects/:projectId", async (context) =>
    context.json(await projectDetail(context.req.param("projectId"), localActor().principalId)),
  );

  /** Stage 4: the design history and any feedback already recorded on it. */
  api.get("/projects/:projectId/design", async (context) => {
    const projectId = context.req.param("projectId");
    const detail = await projectDetail(projectId, localActor().principalId);
    const designs = await designHistory(projectId, detail.project.activeBranchId ?? "");
    const feedback = await Promise.all(
      designs.map(async (design) => ({
        designNodeId: design.id,
        ...(await feedbackFor(design.id)),
      })),
    );
    return context.json({ designs, feedback });
  });

  /** Submits immutable feedback and returns the deterministic revision prompt. */
  api.post("/projects/:projectId/design/feedback", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json()) as {
      designNodeId: string;
      direction: Direction;
      overallNote?: string;
      comments?: { anchor: Record<string, unknown>; body: string }[];
      acceptanceCriteria?: string[];
    };
    const detail = await projectDetail(projectId, localActor().principalId);
    const result = await submitFeedback({
      projectId,
      branchId: detail.project.activeBranchId ?? "",
      designNodeId: body.designNodeId,
      direction: body.direction,
      overallNote: body.overallNote ?? "",
      comments: body.comments ?? [],
      author: localActor().principalId,
      ...(body.acceptanceCriteria ? { acceptanceCriteria: body.acceptanceCriteria } : {}),
    });
    return context.json(result);
  });

  /** Regenerates the design from recorded feedback, and carries dispositions forward. */
  api.post("/projects/:projectId/design/revise", async (context) => {
    const projectId = context.req.param("projectId");
    const body = (await context.req.json()) as { designNodeId: string };
    const detail = await projectDetail(projectId, localActor().principalId);
    if (!detail.current) throw notFound("An open run for that project");
    const result = await redesignFromFeedback({
      projectId,
      branchId: detail.project.activeBranchId ?? "",
      designNodeId: body.designNodeId,
      runId: detail.current.id,
      actor: localActor(),
      projectTitle: detail.project.title,
    });
    return context.json(result);
  });

  api.get("/projects/:projectId/graph", async (context) =>
    context.json(await artifactGraph(context.req.param("projectId"))),
  );

  api.get("/artifacts/:nodeId", async (context) =>
    context.json(await readArtifactNode(context.req.param("nodeId"))),
  );

  /**
   * Orientation from the Product guide — read-only, and never a transition.
   *
   * Falls back to the deterministic checklist rather than failing: "what do I
   * do now" has to be answerable even when no provider will answer it.
   */
  api.get("/projects/:projectId/guidance", async (context) => {
    const projectId = context.req.param("projectId");
    const detail = await projectDetail(projectId, localActor().principalId);
    const live = detail.nodes.filter((node) => node.supersededByNodeId === null);
    const versions = await Promise.all(
      live.map(async (node) => ({
        id: node.id,
        title: node.title,
        stage: node.stage,
        content: (await readArtifactNode(node.id).catch(() => ({ content: "" }))).content,
      })),
    );
    const policy = detail.project.policy as { audienceQuorum?: number };
    const decisions = detail.approvals.filter(
      (approval) => approval.command === "audience.decide",
    );
    return context.json({
      guidance: await runGuidance({
        projectTitle: detail.project.title,
        stage: detail.current?.stage ?? 1,
        state: (detail.current?.state ?? null) as RunState | null,
        versions,
        approvals: detail.approvals.map((approval) => ({
          stage: approval.stage,
          command: approval.command,
          decision: approval.decision,
        })),
        ...(detail.current?.stage === 5
          ? {
              quorum: {
                recorded: decisions.length,
                needed: policy.audienceQuorum ?? 0,
                blocked: decisions.filter((approval) => approval.decision !== "proceed").length,
              },
            }
          : {}),
      }),
    });
  });

  /** Housekeeping on a project: its name, whether it is filed away, and removal. */
  api.patch("/projects/:projectId", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, localActor().principalId);
    const body = (await context.req.json().catch(() => ({}))) as { title?: string; archived?: boolean };
    const title = body.title?.trim();
    if (title !== undefined) {
      if (title.length === 0) throw new HostError("validation_failed", "A project needs a name.", {}, false);
      await renameProject(projectId, title.slice(0, 120));
    }
    if (typeof body.archived === "boolean") await archiveProject(projectId, body.archived);
    return context.json({ ok: true });
  });

  api.delete("/projects/:projectId", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, localActor().principalId);
    await deleteProject(projectId);
    return context.json({ ok: true });
  });
}
