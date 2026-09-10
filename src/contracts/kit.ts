/**
 * The seed record schemas — BUILD_PLAN_V3 §8.
 *
 * §8 asks for "versioned native Interchange records, not a parallel agent
 * runtime", and names the shapes: PromptRecord, SkillRecord, ToolDeclaration,
 * GrantCapability, DirectorRecord, CuratedModelBinding and AgentSeed. The kit
 * had been a TypeScript array — which is a parallel runtime by another name,
 * because nothing outside this process can read it, version it, or say which
 * prompt a given draft was produced from.
 *
 * Two rules the shapes enforce rather than document:
 *
 *   - a binding names a *purpose*, never a vendor model id, so switching
 *     providers is a binding change rather than an edit to ten prompts;
 *   - read, propose and write are separate grants. §8 is explicit that "no
 *     agent gets human approval authority from a workflow-write tool", and a
 *     single "workflow" grant is exactly how that happens by accident.
 */

/** Stable seed keys, in the form §8 fixes: `sb-prompt-<role>-v1`. */
export type PromptRecord = {
  readonly key: string;
  readonly version: number;
  readonly role: string;
  readonly system: string;
  /** What the role is handed, and what it must return. */
  readonly inputs: readonly string[];
  readonly produces: string;
};

export type SkillRecord = {
  readonly key: string;
  readonly version: number;
  readonly instructions: string;
  /** Tool declarations this skill may call, by key. */
  readonly tools: readonly string[];
};

/** A tool, and the single grant that authorises it. */
export type ToolDeclaration = {
  readonly key: string;
  readonly source: "builder" | "interchange";
  readonly mode: "read" | "propose" | "write";
  readonly grantKey: string;
};

export type GrantCapability = {
  readonly key: string;
  readonly capability: string;
  readonly scope: "project" | "tenant";
  /** True where exercising it requires a human decision first. */
  readonly requiresApproval: boolean;
};

/** A named group of agents and the workflows they participate in. */
export type DirectorRecord = {
  readonly key: string;
  readonly title: string;
  readonly agents: readonly string[];
  readonly workflows: readonly string[];
};

/** A purpose, bound to a catalogue entry — never to a vendor model id. */
export type CuratedModelBinding = {
  readonly key: string;
  readonly purpose: string;
  readonly temperature: number;
  /** Named explicitly, because §8 requires fallback to be a decision. */
  readonly fallbackKey: string | null;
};

export type AgentSeed = {
  readonly key: string;
  readonly agent: string;
  readonly promptKey: string;
  readonly skillKeys: readonly string[];
  readonly toolKeys: readonly string[];
  readonly grantKeys: readonly string[];
  readonly directorKey: string;
  readonly modelKey: string;
  /** Set for the four senior-engineer principals, empty for everyone else. */
  readonly panelKey: string | null;
};

/** Everything a seed run writes, in one shape so it can be hashed and diffed. */
export type KitSeed = {
  readonly prompts: readonly PromptRecord[];
  readonly skills: readonly SkillRecord[];
  readonly tools: readonly ToolDeclaration[];
  readonly grants: readonly GrantCapability[];
  readonly directors: readonly DirectorRecord[];
  readonly models: readonly CuratedModelBinding[];
  readonly agents: readonly AgentSeed[];
};

/**
 * A grant a workflow definition requires, in Builder's own words.
 *
 * Shaped to what Interchange resolves at launch, but declared here because
 * only `src/host/hub/` may name the platform's types — the boundary that keeps
 * domain logic free of the runtime it happens to be deployed on.
 */
export type RequiredGrant = {
  readonly resource: string;
  readonly action: "read" | "propose" | "write";
  /** `ask` where §8 says exercising it needs a human decision first. */
  readonly effect: "allow" | "ask";
  /** Resolved against whoever launched the run, never the author. */
  readonly source: "invoker";
};
