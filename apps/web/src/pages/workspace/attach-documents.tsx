/**
 * Project documents attached to a message on purpose. The person's words
 * stay the body of their own mail; each attached document goes to the same
 * specialist as a mail of its own, tagged in its subject with the version
 * the person picked, and the chat shows it as one line (`attachedLine`).
 */
import { useRef } from "react";
import { ChatInputButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, type ChatAttachment } from "@corbits/react-ui";
import { Plus } from "lucide-react";
import { api } from "../../client.js";
import { attachedTag } from "./composed-mail.ts";
import { ATTACHED_HEADING } from "./document-mentions.ts";
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
 * Sends each document before the person's words, so their message is the
 * turn the specialist answers last. Every version is read first: one that
 * has moved on since it was attached refuses the send rather than mail a
 * text the person never saw.
 */
export async function sendAttachedDocuments(tenantId: string, address: string, attached: readonly AttachedDocument[]): Promise<void> {
  const reads = await Promise.all(attached.map((document) => api.artifactContent(tenantId, document.artifactId)));
  for (const [at, document] of attached.entries()) {
    const { version } = reads[at]!;
    if (version === undefined) throw new Error(`${document.label} could not be read.`);
    if (version !== document.version) {
      throw new Error(`${document.label} is at version ${String(version)} now, not the version ${String(document.version)} you attached. Attach it again.`);
    }
  }
  for (const [at, document] of attached.entries()) {
    await api.sendStageMail(tenantId, address, {
      subject: `${attachedTag(document)} ${document.label}`,
      body: `${ATTACHED_HEADING} ${document.label}, version ${String(document.version)}\n\n${reads[at]!.content.trim()}`,
    });
  }
}

/** The composer's (+): the project's documents to attach, and a file to upload as material. */
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
