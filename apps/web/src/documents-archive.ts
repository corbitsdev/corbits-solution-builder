/**
 * "Download documents…" (#323): every finished document of a project as one
 * zip, built in the browser from the artifact graph. The newest unsuperseded
 * version of each document lineage goes in, named by stage and document so
 * the folder reads in process order: Markdown as `.md`, the design as
 * `.html`, slides as `.pptx`. Internal records (uploaded source material,
 * design feedback, build evidence, the delivery manifest) stay out. A README
 * lists what is there and how to get a PDF of any document, since the PDF
 * goes through the browser's print dialog, not a file the app can write.
 */
import JSZip from "jszip";
import type { ArtifactNode } from "./client.js";
import { documentName } from "./components.jsx";
import { mockupShots, type MockupShot, type Shooter } from "./mockup-shots.ts";

/** Where the design's screens go, as pictures (#336). */
export const MOCKUPS_FOLDER = "mockups";

/** `mockups/01-phone-home.png`: the screen's place and name. */
export function mockupFileName(index: number, shot: Pick<MockupShot, "name">): string {
  return `${MOCKUPS_FOLDER}/${String(index + 1).padStart(2, "0")}-${slug(shot.name)}.png`;
}

/** The documents the stages produce for a reader, in process order. */
export const DOCUMENT_KINDS = [
  "problem_brief",
  "solution_constraints",
  "chosen_approach",
  "design_artifact",
  "audience_package",
  "audience_deck",
  "product_requirements",
  "build_plan",
  "engineering_review",
  "cost_approval",
  "build_packet",
  "build_review",
  "delivery_verification",
] as const;

const KIND_ORDER = new Map<string, number>(DOCUMENT_KINDS.map((kind, index) => [kind, index]));

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "document"
  );
}

/** One line of a lineage: the same kind and stakeholder. */
function lineageOf(node: ArtifactNode): string {
  return `${node.kind}|${node.variant ?? ""}`;
}

/**
 * The newest unsuperseded version of each finished document, in process
 * order: by stage, then by kind, then by stakeholder name.
 */
export function completedDocuments(nodes: readonly ArtifactNode[]): ArtifactNode[] {
  const newest = new Map<string, ArtifactNode>();
  for (const node of nodes) {
    if (!KIND_ORDER.has(node.kind) || node.supersededByNodeId !== null) continue;
    const key = lineageOf(node);
    const held = newest.get(key);
    if (!held || node.version > held.version) newest.set(key, node);
  }
  return [...newest.values()].sort(
    (a, b) =>
      a.stage - b.stage ||
      (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
      (a.variant ?? "").localeCompare(b.variant ?? ""),
  );
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,/;

const EXTENSION_OF_MEDIA: Record<string, string> = {
  "text/markdown": "md",
  "text/html": "html",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/** The file's extension: from the content's own media type when it is a `data:` URL, else the node's, else Markdown. */
export function documentExtension(node: Pick<ArtifactNode, "kind" | "mediaType">, content: string): string {
  const match = DATA_URL.exec(content);
  if (match?.[1]) return EXTENSION_OF_MEDIA[match[1]] ?? "bin";
  if (node.kind === "audience_deck") return "pptx";
  if (node.mediaType) return EXTENSION_OF_MEDIA[node.mediaType] ?? "md";
  return "md";
}

/** `06-product-requirements.md`, `05-slides-barry-moneyman.pptx`: stage, document, stakeholder. */
export function documentFileName(node: Pick<ArtifactNode, "kind" | "stage" | "variant" | "mediaType">, content: string): string {
  const stage = String(node.stage).padStart(2, "0");
  const who = node.variant ? `-${slug(node.variant)}` : "";
  return `${stage}-${slug(documentName(node.kind))}${who}.${documentExtension(node, content)}`;
}

export function documentsArchiveName(projectTitle: string): string {
  return `${slug(projectTitle)}-documents.zip`;
}

/** The bytes of a base64 `data:` URL. */
function bytesOf(dataUrl: string): Uint8Array {
  const at = dataUrl.indexOf(",");
  const payload = dataUrl.slice(at + 1);
  if (!/;base64,/.test(dataUrl.slice(0, at + 1))) return new TextEncoder().encode(decodeURIComponent(payload));
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function archiveReadme(projectTitle: string, files: readonly { name: string; node: ArtifactNode }[], mockups: readonly string[] = []): string {
  const lines = files.map(({ name, node }) => `- ${name} — ${documentName(node.kind)}${node.variant ? ` for ${node.variant}` : ""}, version ${String(node.version)}, written ${node.createdAt.slice(0, 10)}`);
  const pictures = mockups.length > 0 ? ["", `The design's screens as pictures, in ${MOCKUPS_FOLDER}/:`, "", ...mockups.map((name) => `- ${name}`)] : [];
  return [
    `# ${projectTitle} — documents`,
    "",
    "The newest version of each finished document, named by stage and document.",
    "",
    ...lines,
    ...pictures,
    "",
    "For a PDF of any document, open it in Solution Builder and choose Export → Print or save as PDF.",
    "Slides are PowerPoint files; the Export menu on the slides can also save them as PDF or open them in Google Slides.",
    "",
  ].join("\n");
}

/**
 * The archive: each finished document under its file name, plus the README.
 * `read` fetches a node's content; a document that cannot be read is left
 * out and named in the README rather than failing the whole download.
 */
export async function assembleDocumentsArchive(
  projectTitle: string,
  nodes: readonly ArtifactNode[],
  read: (node: ArtifactNode) => Promise<string>,
  /** Draws a design's screens (#336); the browser's rasteriser by default, which draws nothing outside a browser. */
  shoot: Shooter = mockupShots,
): Promise<{ blob: Blob; files: string[]; skipped: string[]; mockups: string[] }> {
  const zip = new JSZip();
  const files: { name: string; node: ArtifactNode }[] = [];
  const skipped: string[] = [];
  const mockups: string[] = [];
  for (const node of completedDocuments(nodes)) {
    let content: string;
    try {
      content = await read(node);
    } catch {
      skipped.push(`${documentName(node.kind)}${node.variant ? ` for ${node.variant}` : ""}`);
      continue;
    }
    const name = documentFileName(node, content);
    zip.file(name, DATA_URL.test(content) ? bytesOf(content) : content);
    files.push({ name, node });
    if (node.kind === "design_artifact" && mockups.length === 0) {
      // The screens as pictures, beside the HTML they are drawn from. A
      // design that cannot be drawn leaves the folder out; the HTML stands.
      const shots = await shoot(content, 12).catch((): MockupShot[] => []);
      shots.forEach((shot, index) => {
        const picture = mockupFileName(index, shot);
        zip.file(picture, shot.png);
        mockups.push(picture);
      });
    }
  }
  let readme = archiveReadme(projectTitle, files, mockups);
  if (skipped.length > 0) readme += `\nNot included, since they could not be read: ${skipped.join("; ")}.\n`;
  zip.file("README.md", readme);
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, files: files.map((file) => file.name), skipped, mockups };
}

export type DocumentsArchiveDeps = {
  projectView: (projectId: string) => Promise<{ project: { title: string }; tenantId: string; nodes: ArtifactNode[] }>;
  artifactContent: (tenantId: string, nodeId: string) => Promise<{ content: string }>;
  save: (blob: Blob, name: string) => void;
  /** Draws the design's screens; the browser's rasteriser when absent. */
  shoot?: Shooter;
};

/** Saves the browser's download of a Blob under `name`. */
export function saveBlob(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Downloads a project's finished documents as one zip and returns the notice line. */
export async function downloadProjectDocuments(projectId: string, deps: DocumentsArchiveDeps): Promise<string> {
  const detail = await deps.projectView(projectId);
  const archive = await assembleDocumentsArchive(
    detail.project.title,
    detail.nodes,
    async (node) => (await deps.artifactContent(detail.tenantId, node.id)).content,
    ...(deps.shoot ? [deps.shoot] : []),
  );
  const name = documentsArchiveName(detail.project.title);
  if (archive.files.length === 0) return `${detail.project.title} has no finished documents yet.`;
  deps.save(archive.blob, name);
  const pictures = archive.mockups.length > 0 ? ` and ${String(archive.mockups.length)} mockup picture${archive.mockups.length === 1 ? "" : "s"}` : "";
  const count = `${String(archive.files.length)} document${archive.files.length === 1 ? "" : "s"}${pictures}`;
  return archive.skipped.length > 0
    ? `Saved ${count} of ${detail.project.title} to ${name}; ${String(archive.skipped.length)} could not be read.`
    : `Saved ${count} of ${detail.project.title} to ${name}.`;
}
