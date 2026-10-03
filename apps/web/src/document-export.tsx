/**
 * One way out of every stage document (#242): a menu beside Copy with Save
 * as Markdown and Print or save as PDF. Markdown is what the brief, the
 * requirements and the plan are, so the file is the document itself under
 * the same name the PDF gets; the PDF goes through the print layer as
 * before. A stage 6 draft has no artifact node yet, so `draftNode` stands
 * one in from what the print layer and the file name read off a node.
 */
import { ChevronDown, Download } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@corbits/react-ui";
import type { ArtifactNode } from "./client.js";
import { Button, downloadArtifact } from "./components.jsx";
import { printArtifact, printFileName } from "./print.jsx";

/** `<project>-<document>.md`: the Markdown file's name, the PDF's plus its extension. */
export function markdownFileName(node: ArtifactNode): string {
  return `${printFileName(node)}.md`;
}

/**
 * A node for a document that is still a draft in the conversation, so it
 * can be exported like a recorded one. `title` names the document in the
 * file name and the print header; the rest is what a draft has.
 */
export function draftNode(kind: string, stage: number, title: string): ArtifactNode {
  return {
    id: `draft:${kind}`,
    kind,
    variant: title,
    stage,
    title,
    version: 1,
    position: 1,
    artifactId: `draft:${kind}`,
    contentHash: "",
    mediaType: "text/markdown",
    createdAt: new Date().toISOString(),
    supersededByNodeId: null,
    provenance: { producer: "specialist" },
  };
}

export function DocumentExportMenu({ node, tenantId, content }: { node: ArtifactNode; tenantId: string; content: string }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" doing="Exporting the document">
          <Download aria-hidden="true" />
          Export
          <ChevronDown aria-hidden="true" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => downloadArtifact(content, markdownFileName(node))}>Save as Markdown</MenuItem>
        <MenuItem onSelect={() => printArtifact(node, tenantId, content)}>Print or save as PDF</MenuItem>
      </MenuContent>
    </Menu>
  );
}
