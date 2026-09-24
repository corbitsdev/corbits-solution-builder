import { describe, expect, test } from "bun:test";
import { describeOperation, parseStackRecord, type StackMode, type StackRecord } from "./stack.js";

const CHOICE = { choice: "x", reason: "because", cites: ["FR-1"] };

function record(overrides: Partial<StackRecord> = {}): StackRecord {
  return {
    mode: "plain",
    runtime: CHOICE,
    ui: null,
    storage: null,
    auth: null,
    packaging: { ...CHOICE, kind: "cli" },
    packages: [],
    deferred: [],
    ...overrides,
  };
}

function planWithStack(stack: unknown): string {
  return [
    "# Build plan",
    "",
    "## Stack",
    "",
    "```json stack",
    JSON.stringify(stack, null, 2),
    "```",
    "",
    "## Other section",
    "some prose",
  ].join("\n");
}

describe("parseStackRecord", () => {
  test("parses a well-formed stack block under ## Stack", () => {
    const stack = record({ mode: "hub", hubPlacement: "embedded", storage: CHOICE, auth: CHOICE });
    const parsed = parseStackRecord(planWithStack(stack));
    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe("hub");
    expect(parsed?.hubPlacement).toBe("embedded");
    expect(parsed?.storage?.choice).toBe("x");
  });

  test("returns null with no ## Stack heading", () => {
    expect(parseStackRecord("# Build plan\n\nno stack section here")).toBeNull();
  });

  test("returns null with no fenced json stack block", () => {
    expect(parseStackRecord("# Build plan\n\n## Stack\n\nprose only, no fence")).toBeNull();
  });

  test("returns null on invalid JSON", () => {
    const markdown = ["## Stack", "```json stack", "{ not valid json", "```"].join("\n");
    expect(parseStackRecord(markdown)).toBeNull();
  });

  test("returns null when the shape fails validation", () => {
    const markdown = planWithStack({ mode: "not-a-real-mode", runtime: CHOICE, ui: null, storage: null, auth: null, packaging: { ...CHOICE, kind: "cli" }, packages: [], deferred: [] });
    expect(parseStackRecord(markdown)).toBeNull();
  });

  test("parses a fence opened with plain ```json (no ` stack` tag)", () => {
    const stack = record();
    const markdown = ["## Stack", "", "```json", JSON.stringify(stack, null, 2), "```"].join("\n");
    const parsed = parseStackRecord(markdown);
    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe("plain");
  });
});

describe("describeOperation", () => {
  const cases: { mode: StackMode; overrides?: Partial<StackRecord> }[] = [
    { mode: "plain" },
    { mode: "inference" },
    { mode: "agent" },
    { mode: "local-workflow" },
    { mode: "durable-workflow" },
    { mode: "hub", overrides: { hubPlacement: "embedded" } },
  ];

  for (const { mode, overrides } of cases) {
    test(`describes ${mode}`, () => {
      const description = describeOperation(record({ mode, ...overrides }));
      expect(description.start).not.toBe("");
      expect(description.where).not.toBe("");
      expect(description.who).not.toBe("");
      expect(description.needs).not.toBe("");
      expect(description.cost).not.toBe("");
      expect(description.shareOrCloud).not.toBe("");
      for (const value of Object.values(description)) {
        expect(value.toLowerCase()).not.toContain("@intx");
        expect(value.toLowerCase()).not.toContain("@corbits");
      }
    });
  }

  test("hub mode is stated as multiple people, sharing one deployment", () => {
    const description = describeOperation(record({ mode: "hub", hubPlacement: "cloud" }));
    expect(description.who).toBe("Multiple people, sharing one deployment.");
    expect(description.shareOrCloud).toContain("cloud");
  });

  test("a hub stack with no hubPlacement falls back to 'Not stated in the plan'", () => {
    const description = describeOperation(record({ mode: "hub" }));
    expect(description.start).toBe("Not stated in the plan");
    expect(description.where).toBe("Not stated in the plan");
    expect(description.cost).toBe("Not stated in the plan");
    expect(description.shareOrCloud).toBe("Not stated in the plan");
  });

  test("needs reflects storage and auth without naming packages", () => {
    const none = describeOperation(record());
    expect(none.needs).toBe("Nothing beyond opening it.");
    const both = describeOperation(record({ storage: CHOICE, auth: CHOICE }));
    expect(both.needs).toContain("somewhere to keep data between runs");
    expect(both.needs).toContain("people to sign in");
  });

  test("durable-workflow runs on the person's own machine: no hosting cost", () => {
    const description = describeOperation(record({ mode: "durable-workflow" }));
    expect(description.cost).toBe("No ongoing hosting cost.");
  });

  test("inference and agent modes need a language model", () => {
    expect(describeOperation(record({ mode: "inference" })).needs).toContain("access to a language model (a key or local model)");
    expect(describeOperation(record({ mode: "agent" })).needs).toContain("access to a language model (a key or local model)");
  });

  test("plain and local-workflow modes don't need a language model unless the fields say so", () => {
    expect(describeOperation(record({ mode: "plain" })).needs).not.toContain("language model");
    expect(describeOperation(record({ mode: "local-workflow" })).needs).not.toContain("language model");
  });

  test("a local-workflow/durable-workflow/hub stack needs a language model when its runtime or a package references inference or agents", () => {
    const viaRuntime = describeOperation(
      record({ mode: "local-workflow", runtime: { choice: "x", reason: "runs an agent loop", cites: ["FR-1"] } }),
    );
    expect(viaRuntime.needs).toContain("access to a language model (a key or local model)");

    const viaPackage = describeOperation(
      record({
        mode: "durable-workflow",
        packages: [{ choice: "x", reason: "background summarization", cites: ["FR-1"], name: "@intx/inference" }],
      }),
    );
    expect(viaPackage.needs).toContain("access to a language model (a key or local model)");

    const neither = describeOperation(record({ mode: "hub", hubPlacement: "embedded" }));
    expect(neither.needs).not.toContain("language model");
  });

  test("needs never shows a package name even when a package forces the language-model need", () => {
    const description = describeOperation(
      record({
        mode: "durable-workflow",
        packages: [{ choice: "x", reason: "y", cites: ["FR-1"], name: "@intx/agent" }],
      }),
    );
    expect(description.needs.toLowerCase()).not.toContain("@intx");
  });
});
