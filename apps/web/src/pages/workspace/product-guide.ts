/**
 * The Product guide — BUILD_PLAN_V3 section 8, as solutions-builder-alpha ran
 * it (`apps/hub/src/guide.ts`), with the agent now its own deployment.
 *
 * Calm orientation across all nine stages: where the project stands, what
 * evidence is missing, what the person could do, and which of those is
 * recommended. It reads and it speaks. It never writes an artifact, never
 * dispatches and never records a decision.
 *
 * The guide is handed what the project actually holds, because orientation
 * from a title alone is generic: every live artifact version (each cut to a
 * few thousand characters), the decisions the project workflow recorded, and
 * stage 5's quorum. The checklist is the floor and the agent the enrichment,
 * and the person is always told which of the two they are reading.
 */
import { nextStep, type NextStep } from "@solutions-builder/app/next-step";
import type { RunState } from "@solutions-builder/app/ledger";
import { quorumState } from "@solutions-builder/app/project-workflow/contracts";
import type { ArtifactNode } from "../../client.js";
import type { GuideGuidance } from "../../components.jsx";
import type { ProjectWorkflowView } from "../../project-workflow.js";

/** One live artifact version, as the guide reads it. */
export type GuideVersion = {
  readonly id: string;
  readonly title: string;
  readonly stage: number;
  readonly content: string;
  /** The artifact's kind, which says whether its content is markup. */
  readonly kind?: string;
};

export type GuideContext = {
  readonly projectTitle: string;
  readonly stage: number;
  readonly view: ProjectWorkflowView | null;
  readonly nodes: readonly ArtifactNode[];
  readonly soloApproval?: boolean;
};

/** How much of each version the guide reads, as alpha did. */
const VERSION_CHARS = 4_000;

/** The project's state in the ledger's own words, as the guide and the checklist read it. */
function stateOf(view: ProjectWorkflowView | null): RunState | null {
  if (view === null) return null;
  if (view.done) return "delivered";
  return view.openReview !== null ? "waiting_approval" : "in_progress";
}

function quorumOf(view: ProjectWorkflowView | null, stage: number): { recorded: number; needed: number; blocked: number } | undefined {
  if (stage !== 5 || !view?.audiencePolicy) return undefined;
  const quorum = quorumState(view.audiencePolicy, view.audienceDecisions);
  return { recorded: quorum.proceeded, needed: quorum.required, blocked: quorum.blocked.length };
}

/** The next step the checklist and the guide's button both name. */
export function guideStep(context: GuideContext): NextStep {
  const quorum = quorumOf(context.view, context.stage);
  return nextStep({
    state: stateOf(context.view),
    stage: context.stage,
    hasDraft: context.nodes.some((node) => node.stage === context.stage),
    ...(quorum ? { quorum } : {}),
    ...(context.soloApproval !== undefined ? { soloApproval: context.soloApproval } : {}),
  });
}

/** The deterministic floor. Always available, never wrong, never clever. */
export function deterministicGuidance(context: GuideContext): GuideGuidance {
  const step = guideStep(context);
  const missing: string[] = [];
  if (!context.nodes.some((node) => node.stage === context.stage)) missing.push("This stage has no version yet.");
  const reviews: Readonly<Record<number, unknown>> = context.view?.reviews ?? {};
  if (context.view && !context.view.done && reviews[context.stage] === undefined) {
    missing.push("No decision has been recorded for this stage yet.");
  }
  return {
    summary: `${context.projectTitle} is at stage ${context.stage}. ${step.detail}`,
    readiness: missing.length === 0 ? "ready" : "not_ready",
    missing,
    options: [{ label: step.title, detail: step.detail }],
    recommended: step.title,
    questions: [],
    sourceVersionIds: [],
    origin: "deterministic",
  };
}

/** Kinds that are not text for the guide to read: uploads (served as data:
 *  URLs; their extracted text is `material_reading`), the build archive, and
 *  the workspace's own bookkeeping. */
const UNREADABLE_KINDS = new Set(["source_material", "build_evidence", "withdrawn_turns", "deck_template", "deck_settings"]);
/** How much the guide reads in all, however many versions there are. */
const TOTAL_CHARS = 24_000;

/** The live versions worth fetching for the guide: text kinds only, the
 *  current stage first, then the nearest earlier stages. */
export function guideVersionNodes(nodes: readonly ArtifactNode[], stage: number): ArtifactNode[] {
  const distance = (node: ArtifactNode) => (node.stage === stage ? -1 : Math.abs(stage - node.stage));
  return nodes
    .filter((node) => node.supersededByNodeId === null && !UNREADABLE_KINDS.has(node.kind))
    .sort((a, b) => distance(a) - distance(b));
}

/** Below this, a version's share is a sliver not worth citing as read. */
const MIN_SHARE = 500;

/** Kinds whose content is an HTML page. */
const MARKUP_KINDS = new Set(["design_artifact"]);
/** More than this is never read for a guide request, so stripping it stays
 *  cheap even on pathological markup. */
const MARKUP_INPUT_CAP = 50_000;

/** A numeric entity's character, or U+FFFD for one no string can hold (out of
 *  range, a surrogate half, or NUL). */
function codePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "\uFFFD";
  return String.fromCodePoint(value);
}

/** Whether content is an HTML page, looking past a leading comment, XML
 *  declaration or ```html fence. */
function looksLikeMarkup(content: string): boolean {
  const head = content
    .slice(0, 2_000)
    .replace(/^\s*```html\s*/i, "")
    .replace(/^\s*<\?xml[^>]*\?>/i, "")
    .replace(/^(?:\s*<!--[\s\S]*?-->)+/, "")
    .trimStart();
  return /^<(?:!doctype|[a-z][a-z0-9-]*)[\s>/]/i.test(head);
}

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Markup's words, for designs written as HTML: the guide reads what a page
 *  says, not how it is laid out. Anything else is returned as it is. */
export function textOf(content: string, kind?: string): string {
  if (!(kind !== undefined && MARKUP_KINDS.has(kind)) && !looksLikeMarkup(content)) return content;
  return content
    .slice(0, MARKUP_INPUT_CAP)
    // The cap can cut through a tag; its half is not text.
    .replace(/<[^>]*$/, "")
    .replace(/^\s*```html\s*|\s*```\s*$/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return codePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return codePoint(Number.parseInt(name.slice(1), 10));
      const lower = name.toLowerCase();
      if (lower === "amp") return "&";
      return ENTITIES[lower] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** What the guide is actually sent: each version as text, cut to its share,
 *  empty, unread and data: payloads dropped, within one total budget. Only
 *  these are cited as read. */
export function budgetVersions(versions: readonly GuideVersion[]): GuideVersion[] {
  const sent: GuideVersion[] = [];
  let used = 0;
  for (const version of versions) {
    const raw = version.content.trim();
    if (raw.length === 0 || raw.startsWith("data:")) continue;
    const text = textOf(raw, version.kind);
    if (text.length === 0) continue;
    const room = Math.min(VERSION_CHARS, TOTAL_CHARS - used);
    // A version that fits whole is always worth sending; one that would be
    // cut to a sliver is not, but a shorter one after it still might fit.
    if (text.length > room && room < MIN_SHARE) continue;
    const content = text.slice(0, room);
    sent.push({ ...version, content });
    used += content.length;
  }
  return sent;
}

function decisionLines(view: ProjectWorkflowView | null): string {
  const accepted = (view?.decisions ?? []).filter((decision) => decision.accepted);
  if (accepted.length === 0) return "No decisions have been recorded.";
  return `Recorded decisions: ${accepted
    .map((decision) => {
      const who = decision.audience ? ` by ${decision.audience}` : "";
      const outcome = decision.outcome ? ` → ${decision.outcome}` : "";
      return `stage ${decision.stage} ${decision.kind}${who}${outcome}`;
    })
    .join("; ")}`;
}

/** The request mailed to the guide's own deployment, from the versions
 *  `budgetVersions` chose. */
export function guidancePrompt(context: GuideContext, versions: readonly GuideVersion[]): string {
  const quorum = quorumOf(context.view, context.stage);
  return [
    `Project: ${context.projectTitle}`,
    `Current stage: ${context.stage} of 9. Run state: ${stateOf(context.view) ?? "not started"}.`,
    quorum ? `Stakeholder quorum: ${quorum.recorded} of ${quorum.needed} have proceeded; ${quorum.blocked} blocking.` : "",
    "",
    versions.length === 0
      ? "No versions have been produced yet."
      : versions
          .map((version) => `--- VERSION ${version.id} — ${version.title} (stage ${version.stage}) ---\n${version.content}`)
          .join("\n\n"),
    "",
    decisionLines(context.view),
    "",
    "Orient the person. Be brief, and recommend one next step without taking it.",
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

function sectionsOf(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^#{1,4}\s+(.*)$/.exec(line);
    if (match) {
      if (heading) sections.set(heading.toLowerCase(), body.join("\n").trim());
      heading = match[1]!.trim();
      body = [];
    } else if (heading) {
      body.push(line);
    }
  }
  if (heading) sections.set(heading.toLowerCase(), body.join("\n").trim());
  return sections;
}

const bullets = (block: string): string[] =>
  block
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0 && !/^_?none\b/i.test(line))
    .slice(0, 8);

/** Parses the guide's reply, or null when it is not guidance — the caller
 *  then shows the checklist and says why. `sourceVersionIds` is what the
 *  guide was sent, not anything it claims. Options and a recommendation are
 *  only ever the guide's own: the checklist's are never shown as its words. */
export function parseGuidanceReply(text: string, versions: readonly GuideVersion[]): GuideGuidance | null {
  const sections = sectionsOf(text);
  const summary = sections.get("where this stands")?.trim();
  if (!summary) return null;

  const missing = bullets(sections.get("what is missing") ?? "").map((line) => line.slice(0, 400)).slice(0, 10);
  const options = bullets(sections.get("your options") ?? "")
    .map((line) => {
      const [label, ...rest] = line.split(/\s+[—–-]\s+/);
      return { label: (label ?? line).slice(0, 120), detail: rest.join(" — ").slice(0, 400) };
    })
    .slice(0, 5);
  const recommended = (sections.get("recommended next step") ?? "")
    .split("\n")[0]
    ?.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .trim();

  return {
    summary: summary.slice(0, 1200),
    readiness: missing.length === 0 ? "ready" : "not_ready",
    missing,
    options,
    recommended: (recommended ?? "").slice(0, 120),
    questions: bullets(sections.get("questions") ?? "").map((line) => line.slice(0, 400)),
    sourceVersionIds: versions.map((version) => version.id),
    origin: "agent",
  };
}
