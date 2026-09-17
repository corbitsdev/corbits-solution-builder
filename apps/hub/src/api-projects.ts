import type { Hono } from "hono";
import { DelegationUpdatePayload, ProjectOpenPayload } from "./domain.js";
import { HostError } from "./errors.js";
import { openDecisions } from "./decisions.js";
import {
  artifactGraph,
  listProjects,
  openProject,
  projectDetail,
  readArtifactNode,
  renameProject,
  archiveProject,
  deleteProject,
  revokeProjectDelegations,
} from "./projects.js";
import {
  designHistory,
  feedbackFor,
  recordDisposition,
  submitFeedback,
  type Direction,
} from "./design-feedback.js";
import { requestDraft } from "./stage-runs.js";
import { nameProject } from "./title.js";
import { runGuidance } from "./guide.js";
import { notFound } from "./errors.js";
import { type RunState } from "@solutions-builder/app/ledger";
import { parsed } from "./api.js";
import { localActor } from "./hub-client.js";
import { printableDesign } from "@solutions-builder/tools-deck/print-page";
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
import { deckBytesOf, ensureDeckFor } from "./deck.js";
import { buildBytesOf, slugOf } from "./build-output.js";
import { readProject, delegationStore as liveDelegationStore } from "./installer-bridge.js";
import { projectSpend, workspaceSpend } from "./spend.js";
import { attachMaterial, MATERIAL_KIND, materialText, type IncomingFile } from "./source-material.js";
import { setStakeholders, STAKEHOLDER_ROLES } from "./stakeholders.js";
import { delegateMore, delegationAudit } from "@solutions-builder/installer";

/** `<project>-<document>`: what a printed PDF is saved as, before the dialog adds its extension. */
function printFileName(projectTitle: string, documentTitle: string): string {
  return `${slugOf(projectTitle)}-${slugOf(documentTitle)}`;
}

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

    if (problem.length > 0) {
      // A name for the thing, not a sentence about the person. Best effort and
      // never blocking: a project that will not open because a model is busy
      // is a far worse failure than a plainly-named one.
      await nameProject(problem)
        .then((name) => renameProject(opened.projectId, name))
        .catch((cause: unknown) => {
          console.error("[projects] the project kept its opening name:", cause);
        });
    }

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

  /** What the workspace has spent on inference, by project and by provider. */
  api.get("/spend", async (context) => context.json(await workspaceSpend()));

  /**
   * One project, described: when it began, where it stands, what it holds,
   * and what it has spent on inference with each provider.
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
      spend: await projectSpend(projectId),
    });
  });

  api.get("/artifacts/:nodeId", async (context) =>
    context.json(await readArtifactNode(context.req.param("nodeId"))),
  );

  /**
   * What the specialists are handed for one piece of material — the text of
   * what can be read, or the note that it cannot — so the person can read
   * exactly what the specialist reads, caps and all.
   */
  api.get("/artifacts/:nodeId/reading", async (context) => {
    const { node, content } = await readArtifactNode(context.req.param("nodeId"));
    if (node.kind !== MATERIAL_KIND) {
      throw new HostError("validation_failed", "Only material the person attached has a reading; documents are read as written.");
    }
    return context.json({ text: await materialText(node, content) });
  });

  /**
   * An artifact that is a file — a stakeholder's slides, a spreadsheet the
   * person attached — saved into the same folder exports go to. The window
   * cannot download, so the host writes the file and says where.
   */
  api.post("/artifacts/:nodeId/save", async (context) => {
    const { node, content } = await readArtifactNode(context.req.param("nodeId"));
    const stored = bytesOf(content);
    const bytes =
      stored?.bytes ??
      (node.kind === "audience_deck" ? await deckBytesOf(content) : node.kind === "build_evidence" ? await buildBytesOf(content) : null);
    if (!bytes) {
      throw new HostError("validation_failed", "Only a file is saved this way; documents print from the app.", {}, false);
    }
    const saved = await saveFile(fileNameFor(node.title, stored?.mime ?? node.mediaType), bytes, exportDirectory());
    return context.json(saved);
  });

  /**
   * A stakeholder's slides, saved into the Downloads folder: built from the
   * package now when none exists for this version, and then saved. One
   * request, because that is one act for the person.
   */
  api.post("/artifacts/:nodeId/slides/save", async (context) => {
    const deck = await ensureDeckFor({ packageNodeId: context.req.param("nodeId"), actor: localActor() });
    const { node, content } = await readArtifactNode(deck.nodeId);
    const bytes = await deckBytesOf(content);
    if (!bytes) throw new HostError("internal_error", "The slides were recorded without their bytes.");
    const saved = await saveFile(fileNameFor(node.title, node.mediaType), bytes, exportDirectory());
    return context.json({ ...saved, nodeId: deck.nodeId, built: deck.built });
  });

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
    const project = await readProject(node.projectId);
    const page = printableDesign({
      html: content,
      title: node.title,
      version: node.version,
      fileName: printFileName(project?.title ?? "project", node.title),
    });
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

  /** The people stage 5 writes for and who each decide; the roles they may hold ride along for the editor. */
  api.get("/projects/:projectId/stakeholders", async (context) => {
    const detail = await projectDetail(context.req.param("projectId"), localActor().principalId);
    const policy = detail.project.policy as { audiences: { name: string; role: string }[]; audienceQuorum: number };
    return context.json({ audiences: policy.audiences, audienceQuorum: policy.audienceQuorum, roles: STAKEHOLDER_ROLES });
  });

  api.put("/projects/:projectId/stakeholders", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, localActor().principalId);
    const body = (await context.req.json().catch(() => ({}))) as { audiences?: unknown; audienceQuorum?: unknown };
    const policy = await setStakeholders(projectId, { audiences: body.audiences, audienceQuorum: body.audienceQuorum });
    return context.json({ audiences: policy.audiences, audienceQuorum: policy.audienceQuorum, roles: STAKEHOLDER_ROLES });
  });

  api.delete("/projects/:projectId", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, localActor().principalId);
    await deleteProject(projectId);
    return context.json({ ok: true });
  });

  /**
   * The delegation audit: what the owner consented to at creation, and the
   * live `use` grants in this tenant that carry it. Consent after creation
   * and revocation per workbench live here too.
   */
  api.get("/projects/:projectId/delegations", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, localActor().principalId);
    return context.json(await delegationAudit(liveDelegationStore(), projectId));
  });

  api.post("/projects/:projectId/delegations", async (context) => {
    const projectId = context.req.param("projectId");
    await projectDetail(projectId, localActor().principalId);
    const payload = parsed(DelegationUpdatePayload(await context.req.json()));
    return context.json(
      await delegateMore(liveDelegationStore(), { projectId, delegatedCredentialIds: payload.credentialIds }),
      201,
    );
  });

  api.delete("/projects/:projectId/delegations", async (context) => {
    const projectId = context.req.param("projectId");
    try {
      await projectDetail(projectId, localActor().principalId);
    } catch (cause) {
      // A deleted project 404s its detail, but its tenant — and any surviving
      // delegation grants — are still there. Revocation stays reachable so a
      // stranded delete can be cleaned up; anything but not-found still throws.
      if (!(cause instanceof HostError) || cause.code !== "not_found") throw cause;
    }
    return context.json({ revoked: await revokeProjectDelegations(projectId) });
  });
}
