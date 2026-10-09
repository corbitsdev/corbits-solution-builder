import { describe, expect, test } from "bun:test";
import { AUTHORITIES } from "./ledger.js";
import { STAKEHOLDER_ROLE_IDS, STAKEHOLDERS_BLOCK_SHAPE } from "./stakeholder-roles.js";

// #722: the prompt quotes the role ids from the specialist's package, the
// policy validator takes them from the ledger. One list, held together here,
// so a role added to either is added to both or this fails.
describe("the stakeholder role ids", () => {
  test("are the ledger's authorities less system, in the ledger's order", () => {
    expect([...STAKEHOLDER_ROLE_IDS] as string[]).toEqual(AUTHORITIES.filter((role) => role !== "system"));
  });

  test("are every role the block's shape offers", () => {
    for (const role of STAKEHOLDER_ROLE_IDS) expect(STAKEHOLDERS_BLOCK_SHAPE).toContain(`"${role}"`);
    expect(STAKEHOLDERS_BLOCK_SHAPE).not.toContain('"system"');
    expect(STAKEHOLDERS_BLOCK_SHAPE).toContain('"quorum": number');
  });
});
