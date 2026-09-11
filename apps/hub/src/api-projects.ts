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
  recordDisposition,
  submitFeedback,
  type Direction,
} from "./design-feedback.js";
import { requestDraft } from "./stage-runs.js";
import { nameProject, titleFromProblem } from "./title.js";
import { runGuidance } from "./guide.js";
import { notFound } from "./errors.js";
import { type RunState } from "@solutions-builder/app/ledger";
import { parsed } from "./api.js";
import { localActor } from "./hub-client.js";
import { printableDesign } from "./print-page.js";
import { exportDirectory, exportProject, importProject, parseBundle, saveBundle, bundleFileName } from "./project-transfer.js";

export function registerProjectRoutes(api: Hono) {
  api.get("/decisions", async (context) =>
    context.json({ decisions: await openDecisions() }),
  );

  api.get("/projects", async (context) => context.json({ projects: await listProjects() }));

  api.post("/projects", async (context) => {
    const payload = parsed(ProjectCreatePayload(await context.req.json()));
    const problem = payload.problemStatement?.trim() ?? "";

    // Opened with the plain first line so a project exists whether or not a
    // model is reachable; the real name follows below. What they typed IS the
    // first thing they said, recorded on the `project.create` command itself
    // — not a best-effort side write — so stage 1 opens already knowing the
    // problem rather than asking for it again.
    const created = await createProject({
      title: payload.title || titleFromProblem(problem),
      policy: payload.policy,
      owner: localActor(),
      ...(problem.length > 0 ? { problemStatement: problem } : {}),
    });

    if (problem.length > 0) {
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
    const designs = await designHistory(projectId);
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
    const result = await submitFeedback({
      projectId,
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

    const stored = await feedbackFor(body.designNodeId);
    if (!stored) {
      throw new HostError(
        "validation_failed",
        "No feedback has been submitted against that design version.",
      );
    }

    // The designer is handed the deterministic revision prompt rather than a
    // chat history, which is what makes the resulting version attributable to
    // exactly the feedback that was submitted.
    const result = await requestDraft({
      projectId,
      stage: 4,
      runId: detail.current.id,
      actor: localActor(),
      message: stored.prompt,
      mode: "final",
      projectTitle: detail.project.title,
    });

    // Every comment is dispositioned rather than left implicit. `addressed` is
    // the designer's claim; the human reviewing the next version is what
    // tests it. Anchors that no longer resolve are reported as stale.
    const { stale } = await recordDisposition({
      designNodeId: body.designNodeId,
      newDesignNodeId: result.draft.nodeId,
      dispositions: stored.feedback.comments.map((comment) => ({
        commentId: comment.id,
        disposition: "addressed" as const,
      })),
      actor: localActor(),
    });

    return context.json({ ...result.draft, stale });
  });

  api.get("/projects/:projectId/graph", async (context) =>
    context.json(await artifactGraph(context.req.param("projectId"))),
  );

  /**
   * A project carried out of this instance: everything it records, as one
   * JSON file. The `.json` route hands the bundle back for a browser or a
   * script; the other writes it beside the person's other downloads and says
   * where, which is what the desktop shell needs, since its webview saves
   * nothing on its own.
   */
  api.get("/projects/:projectId/export.json", async (context) => {
    const bundle = await exportProject(context.req.param("projectId"));
    return new Response(JSON.stringify(bundle, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${bundleFileName(bundle.project.title)}"`,
        "cache-control": "no-store",
      },
    });
  });

  api.post("/projects/:projectId/export", async (context) => {
    const bundle = await exportProject(context.req.param("projectId"));
    const saved = await saveBundle(bundle, exportDirectory());
    return context.json({ ...saved, nodes: bundle.artifacts.nodes.length, commands: bundle.ledger.length });
  });

  /** A project carried in: the bundle as the body, a new project here as the answer. */
  api.post("/projects/import", async (context) => {
    const bundle = parseBundle(await context.req.json().catch(() => null));
    return context.json(await importProject(bundle, localActor()));
  });

  api.get("/artifacts/:nodeId", async (context) =>
    context.json(await readArtifactNode(context.req.param("nodeId"))),
  );

  /**
   * A design as a page of its own, with a print bar, so it can be printed or
   * saved as a PDF. Markdown documents print from inside the app, which
   * renders them; only an HTML artifact needs to be left for.
   */
  api.get("/artifacts/:nodeId/print", async (context) => {
    const { node, content } = await readArtifactNode(context.req.param("nodeId"));
    if (node.mediaType !== "text/html") {
      throw new HostError(
        "validation_failed",
        "Only a design is served as a page of its own; other documents print from the app.",
        {},
        false,
      );
    }
    const page = printableDesign({ html: content, title: node.title, version: node.version });
    return new Response(page.body, { headers: page.headers });
  });

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
