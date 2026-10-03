/**
 * Project documents attached to a message on purpose, by reference. The
 * person's words stay the body of their mail; each attached document is one
 * `[attached:<artifactId>:<version>]` tag in its subject, and the specialist
 * reads that version itself with `artifact_read`. The chat shows the tags as
 * chips on the person's own bubble.
 */
import { useRef } from "react";
import { ChatInputButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, type ChatAttachment } from "@corbits/react-ui";
import { Plus } from "lucide-react";
import { api } from "../../client.js";
import { attachedTag, attachedTags } from "./composed-mail.ts";
import type { ArtifactTab } from "./use-project-artifacts.ts";

export type AttachedDocument = { readonly artifactId: string; readonly version: number; readonly label: string };

const TEXT_MEDIA = new Set(["text/markdown", "text/html", "text/plain", "application/json"]);

/** Each strip tab's version as it stands, but the stage's own document (its subject tag already names it) and files that are not text. */
export function attachableDocuments(tabs: readonly ArtifactTab[]): AttachedDocument[] {
  return tabs
    .filter((tab) => !tab.live && TEXT_MEDIA.has(tab.head.mediaType ?? "text/markdown"))
    .map((tab) => ({ artifactId: tab.head.artifactId, version: tab.head.version, label: tab.label }));
}

export function attachmentChips(attached: readonly AttachedDocument[]): ChatAttachment[] {
  return attached.map((document) => ({ id: document.artifactId, name: `${document.label} · v${String(document.version)}` }));
}

/**
 * The subject tags naming the attached documents. Each document is read
 * first: one that has moved on since it was attached refuses the send, so
 * the version the specialist is pointed at is the one the person saw.
 */
export async function attachedSubjectTags(tenantId: string, attached: readonly AttachedDocument[]): Promise<string[]> {
  const reads = await Promise.all(attached.map((document) => api.artifactContent(tenantId, document.artifactId)));
  for (const [at, document] of attached.entries()) {
    const { version } = reads[at]!;
    if (version === undefined) throw new Error(`${document.label} could not be read.`);
    if (version !== document.version) {
      throw new Error(`${document.label} is at version ${String(version)} now, not the version ${String(document.version)} you attached. Attach it again.`);
    }
  }
  return attached.map(attachedTag);
}

export function attachedIn(subject: string | undefined, labels: ReadonlyMap<string, string>): AttachedDocument[] {
  return attachedTags(subject).map((tag) => ({ ...tag, label: labels.get(tag.artifactId) ?? tag.artifactId }));
}

export function AttachedList({ documents }: { documents: readonly AttachedDocument[] }) {
  if (documents.length === 0) return null;
  return (
    <ul className="material-list" aria-label="Attached">
      {documents.map((document) => (
        <li key={document.artifactId} className="material-chip">
          {document.label} · v{document.version}
        </li>
      ))}
    </ul>
  );
}

export function AttachMenu({
  documents,
  attached,
  onAttachDocument,
  onUpload,
  disabled = false,
}: {
  documents: readonly AttachedDocument[];
  attached: readonly AttachedDocument[];
  onAttachDocument: (document: AttachedDocument) => void;
  onUpload?: ((files: FileList) => void) | undefined;
  disabled?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      {onUpload ? (
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            if (event.target.files !== null) onUpload(event.target.files);
            event.target.value = "";
          }}
        />
      ) : null}
      <Menu>
        <MenuTrigger asChild>
          <ChatInputButton aria-label="Attach" title="Attach a project document, or upload a file" disabled={disabled}>
            <Plus className="size-4" aria-hidden="true" />
          </ChatInputButton>
        </MenuTrigger>
        <MenuContent align="start">
          {documents.length > 0 ? <MenuLabel>Project documents</MenuLabel> : null}
          {documents.map((document) => (
            <MenuItem
              key={document.artifactId}
              disabled={attached.some((entry) => entry.artifactId === document.artifactId)}
              onSelect={() => onAttachDocument(document)}
            >
              {document.label} · v{document.version}
            </MenuItem>
          ))}
          {documents.length > 0 && onUpload ? <MenuSeparator /> : null}
          {onUpload ? <MenuItem onSelect={() => fileRef.current?.click()}>Upload a file</MenuItem> : null}
        </MenuContent>
      </Menu>
    </>
  );
}
