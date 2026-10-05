/**
 * AGENTS.md for a project's documents (#686): what a coding agent reads
 * first, in the documents download and in a build attempt's workspace. The
 * precedence of the documents, the rule against inventing behaviour, and
 * the acceptance criteria that mean done, named by the PRD's own ids.
 */
import { extractRequirementItems, mintRequirementEntries } from "./requirements.js";
import { buildDocumentsRule } from "@solutions-builder/specialist-runtime/build-documents";

/** The names the instructions refer to; a caller passes what its package actually holds. */
export type AgentsFiles = {
  readonly requirements: string;
  readonly design: string | null;
  readonly mockups: string | null;
  readonly plan: string | null;
  /** The PRD written for people (#737), when the package has it: named so the agent knows it is not a source. */
  readonly people?: string | null;
};

/** The PRD's acceptance-criterion ids, as minted: "AC-1 through AC-45", a list when they are not one run, or null when it has none. */
export function acceptanceRange(requirementsMarkdown: string): string | null {
  const ids = mintRequirementEntries(extractRequirementItems(requirementsMarkdown))
    .filter((entry) => entry.kind === "AC")
    .map((entry) => entry.id);
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0]!;
  const numbers = ids.map((id) => Number(id.slice(3)));
  const contiguous = numbers.every((n, index) => index === 0 || n === numbers[index - 1]! + 1);
  return contiguous ? `${ids[0]!} through ${ids[ids.length - 1]!}` : ids.join(", ");
}

export const QUESTIONS_MD = "# Open product decisions\n\nRecord here any product decision the documents leave unresolved, with the choice it blocks. Do not choose silently.\n";

export function agentsInstructions(files: AgentsFiles, requirementsMarkdown: string, language?: string): string {
  const range = acceptanceRange(requirementsMarkdown);
  const designLine = files.design || files.mockups
    ? `2. ${[files.design, files.mockups].filter((name): name is string => name !== null).join(" and ")}\n   Authoritative for UI appearance, interaction, states,\n   responsive behavior, and copy where the PRD refers to the design.`
    : `2. (no design document in this package)`;
  const planLine = files.plan
    ? `3. ${files.plan}\n   Authoritative for architecture and implementation strategy only.\n   It MUST NOT override the PRD.`
    : `3. (no build plan in this package)`;
  return [
    "# Implementation instructions",
    "",
    `Build the application defined by ${files.requirements}.`,
    "",
    "Source-of-truth precedence:",
    "",
    `1. ${files.requirements}`,
    "   Authoritative for product behavior, scope, security,",
    "   privacy, requirements, non-goals, and acceptance criteria.",
    "",
    designLine,
    "",
    planLine,
    "",
    "4. Earlier-stage documents",
    "   Context only. They MUST NOT introduce functionality that is absent",
    "   from or explicitly excluded by the PRD.",
    "",
    ...(files.people ? [`${files.people} tells the same requirements for a person to read. It adds`, `nothing to ${files.requirements} and is not a source; build from ${files.requirements}.`, ""] : []),
    "If two documents conflict, follow the higher-priority document.",
    "",
    "Do not invent product behavior to resolve ambiguity.",
    "Record unresolved product decisions in QUESTIONS.md rather than",
    "silently choosing behavior.",
    "",
    range ? `Implementation is complete only when ${range} pass.` : "Implementation is complete only when every acceptance criterion in the PRD passes.",
    "",
    "## Documents every build ships",
    "",
    buildDocumentsRule(language),
    "",
  ].join("\n");
}
