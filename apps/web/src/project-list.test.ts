import { describe, expect, test } from "bun:test";
import { descriptionFromStoredProblem, displayTurn, turnLabel, type TurnDeps } from "./project-list.ts";
import type { ChatMessage } from "./stage-mail.ts";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "1", author: "agent", body: "hello", at: "2026-01-01T00:00:00.000Z", ...overrides };
}

describe("descriptionFromStoredProblem", () => {
  test("first non-empty line, or null — never invented copy", () => {
    expect(
      descriptionFromStoredProblem("Move payroll cutoff + reconciliation off the legacy batch system."),
    ).toBe("Move payroll cutoff + reconciliation off the legacy batch system.");
    expect(descriptionFromStoredProblem("High-volume vehicle telemetry.\nMore detail on a second line.")).toBe(
      "High-volume vehicle telemetry.",
    );
    expect(descriptionFromStoredProblem("\n  \nFirst real line\nSecond")).toBe("First real line");
    expect(descriptionFromStoredProblem("   ")).toBeNull();
    expect(descriptionFromStoredProblem("")).toBeNull();
    expect(descriptionFromStoredProblem(null)).toBeNull();
    expect(descriptionFromStoredProblem(undefined)).toBeNull();
  });
});

describe("turnLabel", () => {
  test("a pending approval wins over everything else", () => {
    const label = turnLabel(1, [message({ body: "A long complete draft. ".repeat(20) + "?" })], true);
    expect(label).toBe("Waiting on a decision");
  });

  test("an open question from the specialist", () => {
    const label = turnLabel(1, [message({ body: "What is the deadline?" })], false);
    expect(label).toBe("Your turn · a question is waiting");
  });

  test("a substantial draft with no open question", () => {
    const draft = [
      "# Problem statement",
      "A support team loses hours finding the latest customer context across separate systems. The immediate pain is that a person must copy information from three places before responding, which delays customers.",
      "",
      "## Success criteria",
      "A teammate can find the current context in one place, understand what is missing, and verify the response path with a representative case that covers the common failure modes seen so far.",
    ].join("\n");
    const label = turnLabel(1, [message({ body: draft })], false);
    expect(label).toBe("Your turn · ready for your approval");
  });

  test("the person spoke last: specialist is working", () => {
    const label = turnLabel(1, [message({ author: "me", body: "sounds good" })], false);
    expect(label).toBe("Specialist working");
  });

  test("nothing to say for an empty thread", () => {
    expect(turnLabel(1, [], false)).toBeNull();
  });

  test("nothing to say for an unreadable agent reply", () => {
    expect(turnLabel(1, [message({ body: "ok" })], false)).toBeNull();
  });
});

describe("displayTurn", () => {
  function deps(overrides: Partial<TurnDeps> = {}): TurnDeps {
    return {
      workspaceTenantId: async () => "tenant_1",
      stageAgentStatus: async () => ({ address: "dep_1@example" }),
      readStageThread: async () => [message({ body: "What is the deadline?" })],
      ...overrides,
    };
  }

  test("resolves the current label from the live thread", async () => {
    const label = await displayTurn(`proj_${crypto.randomUUID()}`, 1, false, deps());
    expect(label).toBe("Your turn · a question is waiting");
  });

  test("caches the result so a second call within the window skips the network", async () => {
    const projectId = `proj_${crypto.randomUUID()}`;
    let calls = 0;
    const d = deps({
      readStageThread: async () => {
        calls += 1;
        return [message({ body: "What is the deadline?" })];
      },
    });
    await displayTurn(projectId, 1, false, d);
    await displayTurn(projectId, 1, false, d);
    expect(calls).toBe(1);
  });

  test("no specialist deployed yet: an empty thread, not a throw", async () => {
    const label = await displayTurn(`proj_${crypto.randomUUID()}`, 1, false, deps({ stageAgentStatus: async () => null }));
    expect(label).toBeNull();
  });

  test("no workspace resolved: null, not a throw", async () => {
    const label = await displayTurn(`proj_${crypto.randomUUID()}`, 1, false, deps({ workspaceTenantId: async () => null }));
    expect(label).toBeNull();
  });
});
