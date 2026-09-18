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
import { notFound } from "./errors.js";
import { parsed } from "./api.js";
import { localActor } from "./hub-client.js";
import { exportDirectory, fileNameFor, saveFile } from "./project-transfer.js";
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

  api.get("/projects/:projectId/graph", async (context) =>
    context.json(await artifactGraph(context.req.param("projectId"))),
  );

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
}
