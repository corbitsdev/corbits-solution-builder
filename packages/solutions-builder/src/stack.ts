/**
 * The build plan's stack decision as data. The Architect emits it as a fenced
 * `json stack` block under `## Stack`; the freeze validates it against the
 * workflow-minted requirement ids; the build worker and the "How it will
 * actually run" section read it instead of prose.
 */

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
