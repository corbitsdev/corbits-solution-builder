import type { Hono } from "hono";
import { ProjectOpenPayload } from "./domain.js";
import { HostError } from "./errors.js";
import { openDecisions } from "./decisions.js";
import {
  artifactGraph,
  listProjects,
  openProject,
  projectDetail,
  readArtifactNode,
} from "./projects.js";
import {
  designHistory,
  feedbackFor,
  submitFeedback,
  type Direction,
} from "./design-feedback.js";
import { runGuidance } from "./guide.js";
import { notFound } from "./errors.js";
import { type RunState } from "@solutions-builder/app/ledger";
import { parsed } from "./api.js";
import { localActor } from "./hub-client.js";
import {
  exportDirectory,
  exportProject,
  fileNameFor,
  importProject,
  parseBundle,
  saveBundle,
  saveFile,
  bundleFileName,
} from "./project-transfer.js";
import { bytesOf } from "./source-material.js";
import { readProject } from "./project-records.js";
import { attachMaterial, MATERIAL_KIND, type IncomingFile } from "./source-material.js";

export function registerProjectRoutes(api: Hono) {
  api.get("/decisions", async (context) =>
    context.json({ decisions: await openDecisions() }),
  );

  api.get("/projects", async (context) => context.json({ projects: await listProjects() }));

  /**
   * The ledger's `project.create`: the tenant already exists (the client ran
   * the installer's `createProject`), and this records the opening run.
   */
  api.post("/projects/:projectId/open", async (context) => {
    const payload = parsed(ProjectOpenPayload(await context.req.json().catch(() => ({}))));
    const problem = payload.problemStatement?.trim() ?? "";
    const opened = await openProject({
      projectId: context.req.param("projectId"),
      owner: localActor(),
      ...(problem.length > 0 ? { problemStatement: problem } : {}),
    });

    return context.json(opened, 201);
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

  /**
   * Files the person hands over with the problem, as multipart `files`. Each
   * becomes a `source_material` version the specialists read at every stage.
   */
  api.post("/projects/:projectId/material", async (context) => {
    const projectId = context.req.param("projectId");
    const detail = await projectDetail(projectId, localActor().principalId);
    const form = await context.req.formData().catch(() => null);
    if (!form) throw new HostError("validation_failed", "Send the files as multipart form data under `files`.");
    const files: IncomingFile[] = [];
    for (const entry of form.getAll("files")) {
      if (entry instanceof File) files.push({ name: entry.name, type: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) });
    }
    const held = detail.nodes
      .filter((node) => node.kind === MATERIAL_KIND && node.supersededByNodeId === null)
      .reduce((sum, node) => sum + node.sizeBytes, 0);
    const attached = await attachMaterial({ projectId, actor: localActor(), files, alreadyHeldBytes: held });
    return context.json({ attached });
  });

  /** A project carried in: the bundle as the body, a new project here as the answer. */
  api.post("/projects/import", async (context) => {
    const bundle = parseBundle(await context.req.json().catch(() => null));
    return context.json(await importProject(bundle, localActor()));
  });

  /**
   * One project, described: when it began, where it stands, and what it holds.
   */
  api.get("/projects/:projectId/info", async (context) => {
    const projectId = context.req.param("projectId");
    const project = await readProject(projectId);
    if (!project) throw notFound("That project");
    const detail = await projectDetail(projectId, localActor().principalId);
    const live = detail.nodes.filter((node) => node.supersededByNodeId === null);
    const byKind = new Map<string, { count: number; bytes: number }>();
    for (const node of detail.nodes) {
      const entry = byKind.get(node.kind) ?? { count: 0, bytes: 0 };
      entry.count += 1;
      entry.bytes += node.sizeBytes;
      byKind.set(node.kind, entry);
    }
    const stamps = [
      ...detail.nodes.map((node) => node.createdAt),
      ...detail.approvals.map((approval) => approval.createdAt),
      ...detail.runs.map((run) => run.createdAt),
    ].filter((value): value is string => typeof value === "string");
    return context.json({
      project: { id: project.id, title: project.title, createdAt: project.createdAt.toISOString(), archivedAt: project.archivedAt?.toISOString() ?? null },
      stage: detail.current ? { stage: detail.current.stage, state: detail.current.state } : null,
      artifacts: {
        versions: detail.nodes.length,
        live: live.length,
        bytes: detail.nodes.reduce((sum, node) => sum + node.sizeBytes, 0),
        byKind: [...byKind.entries()].map(([kind, entry]) => ({ kind, ...entry })).sort((a, b) => b.bytes - a.bytes),
      },
      runs: { total: detail.runs.length, builds: detail.runs.filter((run) => run.kind === "build").length },
      approvals: detail.approvals.length,
      lastActivityAt: stamps.sort().at(-1) ?? project.createdAt.toISOString(),
    });
  });

  /**
   * An artifact that is a file — a stakeholder's slides, a spreadsheet the
   * person attached — saved into the same folder exports go to. The window
   * cannot download, so the host writes the file and says where.
   */
  api.post("/artifacts/:nodeId/save", async (context) => {
    const { node, content } = await readArtifactNode(context.req.param("nodeId"));
    const stored = bytesOf(content);
    if (!stored) {
      throw new HostError("validation_failed", "Only a file is saved this way; documents print from the app.", {}, false);
    }
    const saved = await saveFile(fileNameFor(node.title, stored.mime ?? node.mediaType), stored.bytes, exportDirectory());
    return context.json(saved);
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
        projectId,
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

}
