/**
 * Package revisions the chat produced (#597). A package is recorded by
 * the "Write package" flow, which pairs its own request with the reply.
 * When the person then asks for changes in the chat, the presentation
 * creator rewrites the package in its reply, and nothing recorded it: the
 * slides kept the first version however many times the person asked.
 *
 * The conversation is about one stakeholder at a time: the last package
 * request before a reply, named in its subject, says whose package it revises. A
 * reply in that span that carries a deck outline and is newer than the
 * stakeholder's recorded head is the next version.
 */
import type { ArtifactNode } from "./client.js";
import { packageAudienceOf } from "./pages/workspace/composed-mail.ts";
import type { ChatMessage } from "./stage-mail.ts";
import { packageOutlineProblem } from "@solutions-builder/app/deck";

export type PackageRevision = { readonly name: string; readonly message: ChatMessage };

export function unrecordedPackageRevisions(
  messages: readonly ChatMessage[],
  packages: readonly ArtifactNode[],
  audiences: readonly { readonly name: string }[],
): PackageRevision[] {
  const recordedAt = new Map<string, string>();
  for (const node of packages) {
    if (node.kind !== "audience_package" || !node.variant || node.supersededByNodeId !== null) continue;
    const held = recordedAt.get(node.variant);
    if (!held || node.createdAt > held) recordedAt.set(node.variant, node.createdAt);
  }
  const out: PackageRevision[] = [];
  let current: string | null = null;
  for (const message of messages) {
    if (message.author === "me") {
      const asked = packageAudienceOf(message);
      if (asked !== null && audiences.some((audience) => audience.name === asked)) current = asked;
      continue;
    }
    if (!current || packageOutlineProblem(message.body) !== null) continue;
    const recorded = recordedAt.get(current);
    if (recorded && message.at <= recorded) continue;
    out.push({ name: current, message });
  }
  // Only the newest unrecorded reply per stakeholder is the next version.
  const newest = new Map<string, PackageRevision>();
  for (const revision of out) newest.set(revision.name, revision);
  return [...newest.values()];
}
