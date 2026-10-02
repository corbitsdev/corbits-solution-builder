import { describe, expect, test } from "bun:test";
import { agentById, agentFor } from "./kit.js";
import type { Stage } from "./ledger.js";
import { specialistEntrySource } from "./specialist-source.js";

/**
 * #41 step 1: the rendered entry for every stage and role key, pinned byte
 * for byte. Declaring roles as data must not change one character of what
 * a specialist runs, or every live specialist would be redeployed on the
 * next open for nothing. A deliberate change to the render updates these
 * snapshots (`bun test --update-snapshots`) in the same commit that makes it.
 */
const STAGES: readonly Stage[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const ROLES: readonly { readonly stage: Stage; readonly roleKey: string; readonly roleId: string }[] = [
  ...STAGES.map((stage) => ({ stage, roleKey: "primary", roleId: agentFor(stage).id })),
  { stage: 1, roleKey: "brief-evaluator", roleId: "brief-evaluator" },
  { stage: 1, roleKey: "product-guide", roleId: "product-guide" },
  { stage: 6, roleKey: "requirements-author", roleId: "requirements-author" },
];

describe("specialistEntrySource renders each role byte-identically", () => {
  for (const { stage, roleKey, roleId } of ROLES) {
    for (const artifactTools of [false, true]) {
      test(`stage ${String(stage)} ${roleKey}${artifactTools ? " with artifact tools" : ""}`, () => {
        const role = agentById(roleId);
        if (!role) throw new Error(`no kit role ${roleId}`);
        const rendered = specialistEntrySource({
          stage,
          source: { provider: "openai", model: "gpt-5.5" },
          role,
          roleKey,
          artifactTools,
          ...(artifactTools ? { artifactCredentialId: "crd_snapshot" } : {}),
        });
        expect(rendered).toMatchSnapshot();
      });
    }
  }
});
