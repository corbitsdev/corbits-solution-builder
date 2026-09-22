/**
 * The build plan's stack decision as data. The Architect emits it as a fenced
 * `json stack` block under `## Stack`; the freeze validates it against the
 * workflow-minted requirement ids; the build worker and the "How it will
 * actually run" section read it instead of prose.
 */
import { type } from "arktype";

/** CL-8861 modes: the smallest that meets the requirements. */
export type StackMode =
  | "plain" // 1: no Interchange
  | "inference" // 2: @intx/inference in-process
  | "agent" // 3: @intx/agent in-process
  | "local-workflow" // 4: @intx/workflow runLocal (agentic or not)
  | "durable-workflow" // 5: + @intx/workflow-host
  | "hub"; // 6: Interchange hub (embedded-host on one machine, or cloud)

export type Packaging = "compiled-binary" | "web-hosted" | "desktop" | "cli" | "library";

export interface StackChoice {
  readonly choice: string;
  readonly reason: string;
  /** Workflow-minted requirement ids (see `RequirementEntry.id`). Never empty. */
  readonly cites: readonly string[];
}

export interface StackRecord {
  readonly mode: StackMode;
  /** Required when mode is "hub": where the hub runs for v1. */
  readonly hubPlacement?: "embedded" | "cloud";
  readonly runtime: StackChoice;
  readonly ui: StackChoice | null;
  readonly storage: StackChoice | null;
  readonly auth: StackChoice | null;
  readonly packaging: StackChoice & { readonly kind: Packaging };
  /** Capability packages (@intx/*, @corbits/*); each forced by a requirement. */
  readonly packages: readonly (StackChoice & { readonly name: string })[];
  /** Things considered and not forced by any requirement. Not built. */
  readonly deferred: readonly string[];
}

export type RequirementKind = "FR" | "NFR" | "IR" | "AC";

/** A requirement as the workflow recorded it. The id is minted by the
 *  workflow, never by a specialist, so every consumer agrees on it. */
export interface RequirementEntry {
  readonly id: string;
  readonly kind: RequirementKind;
  readonly text: string;
}

export interface StackCitationProblem {
  readonly entry: string;
  readonly problem: "uncited" | "unknown_requirement";
  readonly ids?: readonly string[];
}

export function stackEntries(stack: StackRecord): readonly [string, StackChoice][] {
  const fixed: [string, StackChoice | null][] = [
    ["runtime", stack.runtime],
    ["ui", stack.ui],
    ["storage", stack.storage],
    ["auth", stack.auth],
    ["packaging", stack.packaging],
  ];
  return [
    ...fixed.filter((e): e is [string, StackChoice] => e[1] !== null),
    ...stack.packages.map((p): [string, StackChoice] => [`package:${p.name}`, p]),
  ];
}

export function checkStackCitations(
  stack: StackRecord,
  requirementIds: ReadonlySet<string>,
): readonly StackCitationProblem[] {
  return stackEntries(stack).flatMap(([entry, c]): StackCitationProblem[] => {
    if (c.cites.length === 0) return [{ entry, problem: "uncited" }];
    const unknown = c.cites.filter((id) => !requirementIds.has(id));
    return unknown.length ? [{ entry, problem: "unknown_requirement", ids: unknown }] : [];
  });
}

// --- Parsing the Architect's plan text (CL-8862) -----------------------

const StackChoiceSchema = type({
  choice: "string",
  reason: "string",
  cites: "string[]",
});

const PackagingSchema = type({
  choice: "string",
  reason: "string",
  cites: "string[]",
  kind: "'compiled-binary'|'web-hosted'|'desktop'|'cli'|'library'",
});

const PackageEntrySchema = type({
  choice: "string",
  reason: "string",
  cites: "string[]",
  name: "string",
});

const StackRecordSchema = type({
  mode: "'plain'|'inference'|'agent'|'local-workflow'|'durable-workflow'|'hub'",
  "hubPlacement?": "'embedded'|'cloud'",
  runtime: StackChoiceSchema,
  ui: StackChoiceSchema.or("null"),
  storage: StackChoiceSchema.or("null"),
  auth: StackChoiceSchema.or("null"),
  packaging: PackagingSchema,
  packages: PackageEntrySchema.array(),
  deferred: "string[]",
});

const STACK_HEADING_RE = /^##\s+Stack\s*$/m;
const STACK_BLOCK_RE = /```json stack\r?\n([\s\S]*?)```/;

/**
 * Finds the ```json stack fenced block under the Architect plan's `## Stack`
 * heading and validates it into a `StackRecord`. Anything short of a clean
 * parse -- no heading, no fence, invalid JSON, or a shape arktype rejects --
 * is `null`, never a best-effort guess.
 */
export function parseStackRecord(markdown: string): StackRecord | null {
  const headingIndex = markdown.search(STACK_HEADING_RE);
  if (headingIndex < 0) return null;
  const match = STACK_BLOCK_RE.exec(markdown.slice(headingIndex));
  if (!match) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  const parsed = StackRecordSchema(json);
  return parsed instanceof type.errors ? null : (parsed as StackRecord);
}

// --- Plain-language description (CL-8862) -------------------------------

/** The "How it will actually run" section a person sees -- never a package
 *  name, only what happens, where, and for whom. */
export interface OperationDescription {
  readonly start: string;
  readonly where: string;
  readonly who: string;
  readonly needs: string;
  readonly cost: string;
  readonly shareOrCloud: string;
}

const NOT_STATED = "Not stated in the plan";

function describeStart(stack: StackRecord): string {
  switch (stack.mode) {
    case "plain":
      return "Opens the built app directly.";
    case "inference":
      return "Opens the built app directly; it talks to a language model in the background.";
    case "agent":
      return "Opens the built app; an autonomous helper carries out the steps of a request.";
    case "local-workflow":
      return "Opens the built app, which runs its steps locally when triggered.";
    case "durable-workflow":
      return "Opens the built app; the work it starts keeps going even if the app is closed and reopened.";
    case "hub":
      if (stack.hubPlacement === "cloud") return "Signs in from a browser -- nothing to install.";
      if (stack.hubPlacement === "embedded") return "Opens the built app, which also runs the shared hub locally.";
      return NOT_STATED;
  }
}

function describeWhere(stack: StackRecord): string {
  switch (stack.mode) {
    case "plain":
    case "inference":
    case "agent":
    case "local-workflow":
      return "On the person's own machine.";
    case "durable-workflow":
      return "On the person's own machine, with work continuing in the background.";
    case "hub":
      if (stack.hubPlacement === "cloud") return "In the cloud, on infrastructure someone else runs.";
      if (stack.hubPlacement === "embedded") return "On one machine that also hosts the shared hub for everyone using it.";
      return NOT_STATED;
  }
}

function describeWho(stack: StackRecord): string {
  return stack.mode === "hub" ? "Multiple people, sharing one deployment." : "One person, on their own machine.";
}

function describeNeeds(stack: StackRecord): string {
  const parts: string[] = [];
  if (stack.storage !== null) parts.push("somewhere to keep data between runs");
  if (stack.auth !== null) parts.push("people to sign in");
  return parts.length ? `Needs ${parts.join(" and ")}.` : "Nothing beyond opening it.";
}

function describeCost(stack: StackRecord): string {
  switch (stack.mode) {
    case "plain":
    case "inference":
    case "agent":
    case "local-workflow":
      return "No ongoing hosting cost.";
    case "durable-workflow":
      return "Some ongoing hosting cost, to keep it running in the background.";
    case "hub":
      if (stack.hubPlacement === "cloud") return "Ongoing hosting cost, paid to run it in the cloud.";
      if (stack.hubPlacement === "embedded") return "No extra hosting cost beyond the one machine running it.";
      return NOT_STATED;
  }
}

function describeShareOrCloud(stack: StackRecord): string {
  switch (stack.mode) {
    case "plain":
    case "inference":
    case "agent":
    case "local-workflow":
      return "Not shared automatically -- each person runs their own copy.";
    case "durable-workflow":
      return "Not shared between people automatically, though it keeps working unattended.";
    case "hub":
      if (stack.hubPlacement === "cloud") return "Shared, and reachable from anywhere via the cloud.";
      if (stack.hubPlacement === "embedded") return "Shared with everyone pointed at that one machine.";
      return NOT_STATED;
  }
}

/**
 * Maps a `StackRecord` to the plain-language fields a person sees -- never a
 * package name. A field with nothing to derive it from (an unset
 * `hubPlacement` on a `hub` stack) reads "Not stated in the plan" rather than
 * a guess.
 */
export function describeOperation(stack: StackRecord): OperationDescription {
  return {
    start: describeStart(stack),
    where: describeWhere(stack),
    who: describeWho(stack),
    needs: describeNeeds(stack),
    cost: describeCost(stack),
    shareOrCloud: describeShareOrCloud(stack),
  };
}
