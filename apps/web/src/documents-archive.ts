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
import type { MockupShot, Shooter } from "./mockup-shots.ts";
import { frameLabel, frameMockup } from "./mockup-frames.ts";
import { cachedFramedMockupShots } from "./mockup-cache.ts";
import { QUESTIONS_MD, agentsInstructions } from "@solutions-builder/app/agents-instructions";
import { slug } from "./slug.ts";
import { PRD_FOR_PEOPLE_FILE, PRD_FOR_PEOPLE_KIND, cleanPeopleDocument, mockupKey, resolveMockupReferences } from "./prd-for-people.ts";

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
  PRD_FOR_PEOPLE_KIND,
  "build_plan",
  "engineering_review",
  "cost_approval",
  "build_packet",
  "build_review",
  "delivery_verification",
] as const;

const KIND_ORDER = new Map<string, number>(DOCUMENT_KINDS.map((kind, index) => [kind, index]));

export { slug };

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
/** Whether the text is an HTML document, whatever its node says (#338): a design recorded before media types were. */
function looksLikeHtml(content: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content);
}

export function documentExtension(node: Pick<ArtifactNode, "kind" | "mediaType">, content: string): string {
  const match = DATA_URL.exec(content);
  if (match?.[1]) return EXTENSION_OF_MEDIA[match[1]] ?? "bin";
  if (looksLikeHtml(content)) return "html";
  if (node.kind === "audience_deck") return "pptx";
  if (node.mediaType) return EXTENSION_OF_MEDIA[node.mediaType] ?? "md";
  return "md";
}

/** `06-product-requirements.md`, `05-slides-barry-moneyman.pptx`: stage, document, stakeholder. */
export function documentFileName(node: Pick<ArtifactNode, "kind" | "stage" | "variant" | "mediaType">, content: string): string {
  // The PRD for people goes by the name it was asked for (#737).
  if (node.kind === PRD_FOR_PEOPLE_KIND) return PRD_FOR_PEOPLE_FILE;
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

export function archiveReadme(projectTitle: string, files: readonly { name: string; node: ArtifactNode }[], mockups: readonly string[] = [], withAgents = false): string {
  const lines = files.map(({ name, node }) => `- ${name} — ${documentName(node.kind)}${node.variant ? ` for ${node.variant}` : ""}, version ${String(node.version)}, written ${node.createdAt.slice(0, 10)}`);
  const pictures = mockups.length > 0 ? ["", `The design's screens as pictures, in ${MOCKUPS_FOLDER}/:`, "", ...mockups.map((name) => `- ${name}`)] : [];
  const agents = withAgents ? ["", "For a coding agent: AGENTS.md says which document wins where they disagree and which acceptance criteria mean done; QUESTIONS.md is where it records product decisions the documents leave open."] : [];
  return [
    `# ${projectTitle} — documents`,
    "",
    "The newest version of each finished document, named by stage and document.",
    "",
    ...lines,
    ...pictures,
    ...agents,
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
  /** Draws a design's screens (#336); the session's cached drawing by default (#751), which draws nothing outside a browser. */
  shoot: Shooter = cachedFramedMockupShots,
  /** Draws a screen inside its body (#654) when the shooter did not already (`framed`); the canvas framer by default. A frame that fails leaves the screen bare. */
  frame: (shot: MockupShot) => Promise<Uint8Array> = frameMockup,
  /** Says which step is under way (#751), for the busy strip. */
  progress: (doing: string) => void = () => undefined,
): Promise<{ blob: Blob; files: string[]; skipped: string[]; mockups: string[] }> {
  const zip = new JSZip();
  const files: { name: string; node: ArtifactNode }[] = [];
  const contentOf = new Map<string, string>();
  const skipped: string[] = [];
  const mockups: string[] = [];
  // The pictures by screen key (#737), for the PRD for people's references.
  const pictures = new Map<string, string>();
  // Every document is fetched at once (#751), then packed in order.
  const documents = completedDocuments(nodes);
  progress(`Reading ${String(documents.length)} document${documents.length === 1 ? "" : "s"}`);
  const contents = await Promise.all(documents.map((node) => read(node).then((content) => ({ content }), () => null)));
  for (const [index, node] of documents.entries()) {
    const held = contents[index];
    if (!held) {
      skipped.push(`${documentName(node.kind)}${node.variant ? ` for ${node.variant}` : ""}`);
      continue;
    }
    let content = held.content;
    // The PRD for people goes out without any word about itself (#742).
    if (node.kind === PRD_FOR_PEOPLE_KIND) content = cleanPeopleDocument(content);
    const name = documentFileName(node, content);
    zip.file(name, DATA_URL.test(content) ? bytesOf(content) : content);
    files.push({ name, node });
    contentOf.set(name, content);
    if (node.kind === "design_artifact" && mockups.length === 0) {
      // The screens as pictures, beside the HTML they are drawn from. A
      // design that cannot be drawn leaves the folder out; the HTML stands.
      progress("Drawing the design's screens");
      const shots = await shoot(content, 12).catch((): MockupShot[] => []);
      for (const [index, shot] of shots.entries()) {
        const picture = mockupFileName(index, shot);
        zip.file(picture, await frame(shot).catch(() => shot.png));
        mockups.push(`${picture} — ${frameLabel(shot.kind)}`);
        pictures.set(mockupKey(shot.name), picture);
      }
    }
  }
  // The PRD for people names pictures by screen (#737); each reference is
  // rewritten to the file the folder holds, so the document reads in place.
  const peopleFile = files.find((file) => file.node.kind === PRD_FOR_PEOPLE_KIND);
  if (peopleFile && pictures.size > 0) {
    const resolved = resolveMockupReferences(contentOf.get(peopleFile.name) ?? "", pictures);
    zip.file(peopleFile.name, resolved);
    contentOf.set(peopleFile.name, resolved);
  }
  // The coding agent's instructions (#686), naming the package's own files
  // and the PRD's acceptance criteria, when the package has a PRD.
  const requirementsFile = files.find((file) => file.node.kind === "product_requirements");
  if (requirementsFile) {
    const named = (kind: string) => files.find((file) => file.node.kind === kind)?.name ?? null;
    zip.file(
      "AGENTS.md",
      agentsInstructions(
        { requirements: requirementsFile.name, design: named("design_artifact"), mockups: mockups.length > 0 ? `${MOCKUPS_FOLDER}/` : null, plan: named("build_plan"), people: named(PRD_FOR_PEOPLE_KIND) },
        contentOf.get(requirementsFile.name) ?? "",
      ),
    );
    zip.file("QUESTIONS.md", QUESTIONS_MD);
  }
  progress("Packing the archive");
  let readme = archiveReadme(projectTitle, files, mockups, requirementsFile !== undefined);
  const mockupFiles = mockups.map((entry) => entry.split(" — ")[0]!);
  if (skipped.length > 0) readme += `\nNot included, since they could not be read: ${skipped.join("; ")}.\n`;
  zip.file("README.md", readme);
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, files: files.map((file) => file.name), skipped, mockups: mockupFiles };
}

export type DocumentsArchiveDeps = {
  projectView: (projectId: string) => Promise<{ project: { title: string }; tenantId: string; nodes: ArtifactNode[] }>;
  artifactContent: (tenantId: string, nodeId: string) => Promise<{ content: string }>;
  save: (blob: Blob, name: string) => void;
  /** Draws the design's screens; the session's cached drawing when absent. */
  shoot?: Shooter;
  /** Says which step is under way (#751), for the busy strip. */
  onProgress?: (doing: string) => void;
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

/** Downloads a project's finished documents as one zip and says what went in; `complete` is false when nothing or not everything was saved. */
export async function downloadProjectDocuments(projectId: string, deps: DocumentsArchiveDeps): Promise<{ message: string; complete: boolean; saveAgain?: () => void }> {
  const detail = await deps.projectView(projectId);
  const archive = await assembleDocumentsArchive(
    detail.project.title,
    detail.nodes,
    async (node) => (await deps.artifactContent(detail.tenantId, node.id)).content,
    deps.shoot ?? cachedFramedMockupShots,
    frameMockup,
    deps.onProgress ?? (() => undefined),
  );
  const name = documentsArchiveName(detail.project.title);
  if (archive.files.length === 0) return { message: `${detail.project.title} has no finished documents yet.`, complete: false };
  deps.save(archive.blob, name);
  // The save runs after seconds of work, outside the click's activation
  // (#748); a browser that holds such a download back says nothing, so
  // the notice offers the same file again from a click.
  const saveAgain = () => deps.save(archive.blob, name);
  const pictures = archive.mockups.length > 0 ? ` and ${String(archive.mockups.length)} mockup picture${archive.mockups.length === 1 ? "" : "s"}` : "";
  const count = `${String(archive.files.length)} document${archive.files.length === 1 ? "" : "s"}${pictures}`;
  return archive.skipped.length > 0
    ? { message: `Saved ${count} of ${detail.project.title} to ${name}; ${String(archive.skipped.length)} could not be read.`, complete: false, saveAgain }
    : { message: `Saved ${count} of ${detail.project.title} to ${name}.`, complete: true, saveAgain };
}
