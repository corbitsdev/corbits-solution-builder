import { describe, expect, test } from "bun:test";
import type { ResolvedCatalogRow } from "../client.js";
import { describeResolvedRow } from "./providers.js";

function row(overrides: Partial<ResolvedCatalogRow> = {}): ResolvedCatalogRow {
  return {
    modelId: "m-sonnet",
    canonicalName: "anthropic/sonnet",
    displayName: "Sonnet",
    providerNames: ["Anthropic"],
    priority: 5,
    isDefault: false,
    restricted: false,
    shadowed: false,
    chatCapable: true,
    defaultCandidate: true,
    credentialConnected: true,
    offeringIds: ["off-sonnet"],
    providerRowIds: ["mp-anthropic"],
    ...overrides,
  };
}

describe("describeResolvedRow", () => {
  test("chat rows keep their fallback rank label", () => {
    expect(describeResolvedRow(row(), 0)).toContain("Answers first");
    expect(describeResolvedRow(row(), 2)).toContain("Fallback 2");
  });

  test("restricted rows never render a rank label", () => {
    expect(describeResolvedRow(row({ restricted: true }), 0)).not.toMatch(/Answers first|Fallback/);
    expect(describeResolvedRow(row({ restricted: true }), 2)).not.toMatch(/Answers first|Fallback/);
  });

  test("non-chat rows never render a rank label", () => {
    expect(describeResolvedRow(row({ chatCapable: false }), 0)).not.toMatch(/Answers first|Fallback/);
    expect(describeResolvedRow(row({ chatCapable: false }), 2)).not.toMatch(/Answers first|Fallback/);
    // The sub-line still names the route and model, never a rank.
    expect(describeResolvedRow(row({ chatCapable: false }), 2)).toBe("via Anthropic · anthropic/sonnet");
  });
});
