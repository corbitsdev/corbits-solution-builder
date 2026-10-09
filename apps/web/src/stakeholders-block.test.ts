import { describe, expect, test } from "bun:test";
import { AUTHORITIES } from "@solutions-builder/app/ledger";
import { STAKEHOLDER_ROLE_IDS } from "@solutions-builder/app/stakeholder-roles";
import { STAKEHOLDER_ROLES } from "./client.ts";
import { fencedBlocks, interviewBlockOf, stakeholdersBlockOf } from "./stakeholders-block.ts";

const ROSTER = { audiences: [{ name: "You", role: "project_owner" }, { name: "Brent Mattson", role: "budget_approver" }], quorum: 2 };

function reply(block: unknown, tag = "json stakeholders"): string {
  return ["You and Brent Mattson, 2 of 2 to proceed. Confirmed.", "", `\`\`\`${tag}`, typeof block === "string" ? block : JSON.stringify(block, null, 2), "```", "", "The packages can be written now."].join("\n");
}

// #722: the roster the Presentation creator confirms is read off its reply
// and saved as the policy, so nothing short of a clean roster is read.
describe("stakeholdersBlockOf", () => {
  test("reads a clean block, names trimmed", () => {
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: " You ", role: "project_owner" }], quorum: 1 }))).toEqual({ audiences: [{ name: "You", role: "project_owner" }], quorum: 1 });
    expect(stakeholdersBlockOf(reply(ROSTER))).toEqual(ROSTER);
  });

  test("a role the project does not know is null, never guessed", () => {
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: "Ada", role: "cfo" }], quorum: 1 }))).toBeNull();
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: "Ada", role: "system" }], quorum: 1 }))).toBeNull();
  });

  test("no fence, or a fence without the tag, is null", () => {
    expect(stakeholdersBlockOf("You alone, 1 of 1. " + JSON.stringify(ROSTER))).toBeNull();
    expect(stakeholdersBlockOf(reply(ROSTER, "json"))).toBeNull();
    expect(stakeholdersBlockOf(reply(ROSTER, "json stack"))).toBeNull();
  });

  test("two blocks is a reply that could not decide: null", () => {
    expect(stakeholdersBlockOf(`${reply(ROSTER)}\n\n${reply({ audiences: [{ name: "You", role: "project_owner" }], quorum: 1 })}`)).toBeNull();
    expect(fencedBlocks(`${reply(ROSTER)}\n\n${reply(ROSTER)}`, "stakeholders")).toHaveLength(2);
  });

  test("a trailing comma is forgiven, nothing else in the JSON is", () => {
    expect(stakeholdersBlockOf(reply('{ "audiences": [{ "name": "You", "role": "project_owner" },], "quorum": 1, }'))).toEqual({ audiences: [{ name: "You", role: "project_owner" }], quorum: 1 });
    expect(stakeholdersBlockOf(reply("{ not json"))).toBeNull();
  });

  test("a blank or repeated name, no entries, or a quorum past the count is null", () => {
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: "  ", role: "project_owner" }], quorum: 1 }))).toBeNull();
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: "You", role: "project_owner" }, { name: "you", role: "audience_member" }], quorum: 1 }))).toBeNull();
    expect(stakeholdersBlockOf(reply({ audiences: [], quorum: 0 }))).toBeNull();
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: "You", role: "project_owner" }], quorum: 2 }))).toBeNull();
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: "You", role: "project_owner" }], quorum: 1.5 }))).toBeNull();
    expect(stakeholdersBlockOf(reply({ audiences: [{ name: "You", role: "project_owner" }], quorum: "1" }))).toBeNull();
  });

  test("a jsonc or JSON fence with the tag is still read", () => {
    expect(stakeholdersBlockOf(reply(ROSTER, "jsonc stakeholders"))).toEqual(ROSTER);
    expect(stakeholdersBlockOf(reply(ROSTER, "JSON stakeholders"))).toEqual(ROSTER);
  });
});

// The prompt's list, the block's validator and the policy's validator are one
// list: the ledger's authorities less "system".
describe("the roles the block accepts", () => {
  test("are the roles the policy accepts and the ledger names", () => {
    expect([...STAKEHOLDER_ROLE_IDS] as string[]).toEqual([...STAKEHOLDER_ROLES]);
    expect([...STAKEHOLDER_ROLE_IDS] as string[]).toEqual(AUTHORITIES.filter((role) => role !== "system"));
  });
});

// #722: an approver's interview, read on the same terms as the roster.
describe("interviewBlockOf", () => {
  const INTERVIEW = { name: "Brent Mattson", interview: [{ question: " What do you most need to see to say yes? ", answer: "The cost ceiling. " }, { question: "What would make you say no?", answer: "A year to build." }] };
  function reply(block: unknown, tag = "json stakeholder-interview"): string {
    return ["Noted, Brent.", "", `\`\`\`${tag}`, typeof block === "string" ? block : JSON.stringify(block), "```", "", "Next, Dana."].join("\n");
  }

  test("reads a clean block, both sides trimmed", () => {
    expect(interviewBlockOf(reply(INTERVIEW))).toEqual({
      name: "Brent Mattson",
      interview: [{ question: "What do you most need to see to say yes?", answer: "The cost ceiling." }, { question: "What would make you say no?", answer: "A year to build." }],
    });
  });

  test("no fence, the roster's tag, or two blocks is null", () => {
    expect(interviewBlockOf("Noted. " + JSON.stringify(INTERVIEW))).toBeNull();
    expect(interviewBlockOf(reply(INTERVIEW, "json stakeholders"))).toBeNull();
    expect(interviewBlockOf(`${reply(INTERVIEW)}\n\n${reply(INTERVIEW)}`)).toBeNull();
  });

  test("no name, no entries, more than five, a side missing, or a side over 500 characters is null", () => {
    expect(interviewBlockOf(reply({ name: " ", interview: INTERVIEW.interview }))).toBeNull();
    expect(interviewBlockOf(reply({ name: "Brent", interview: [] }))).toBeNull();
    expect(interviewBlockOf(reply({ name: "Brent", interview: Array.from({ length: 6 }, () => ({ question: "q", answer: "a" })) }))).toBeNull();
    expect(interviewBlockOf(reply({ name: "Brent", interview: [{ question: "q", answer: "" }] }))).toBeNull();
    expect(interviewBlockOf(reply({ name: "Brent", interview: [{ question: "q" }] }))).toBeNull();
    expect(interviewBlockOf(reply({ name: "Brent", interview: [{ question: "q", answer: "a".repeat(501) }] }))).toBeNull();
    expect(interviewBlockOf(reply("{ not json"))).toBeNull();
  });

  test("a roster block is not read as an interview, nor the other way round", () => {
    const roster = ["```json stakeholders", JSON.stringify({ audiences: [{ name: "You", role: "project_owner" }], quorum: 1 }), "```"].join("\n");
    expect(interviewBlockOf(roster)).toBeNull();
    expect(stakeholdersBlockOf(reply(INTERVIEW))).toBeNull();
  });
});
