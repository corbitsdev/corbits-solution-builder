import { describe, expect, test } from "bun:test";
import { deckFrom, renderDeck } from "@solutions-builder/app/deck";
import { deckSettingsContent, parseDeckSettings, readTemplateTheme, slidesSource, withRoleTemplate } from "./deck-templates.ts";

const OUTLINE = `# Audience package

### Deck outline

1. **The problem** — Costs are rising faster than revenue.
2. **The plan** — Ship the pilot in Q1.

### Decision request

- Approve the pilot budget.
`;

describe("readTemplateTheme", () => {
  test("reads a theme's colours, typefaces and slide ratio from a .pptx fixture", async () => {
    const deck = deckFrom({ projectTitle: "Acme", audience: "Finance", role: "Approver", markdown: OUTLINE })!;
    const bytes = await renderDeck(deck);
    const theme = await readTemplateTheme(bytes);
    expect(theme.accent).toMatch(/^[0-9A-F]{6}$/);
    expect(theme.ink).toMatch(/^[0-9A-F]{6}$/);
    expect(theme.paper).toMatch(/^[0-9A-F]{6}$/);
    expect(theme.titleFace).toBeTruthy();
    expect(theme.bodyFace).toBeTruthy();
    expect(theme.ratio).toBeCloseTo(1.78, 1);
  });

  test("returns an empty theme for bytes with no theme part", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("nothing.txt", "hello");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const theme = await readTemplateTheme(bytes);
    expect(theme).toEqual({});
  });
});

describe("parseDeckSettings", () => {
  test("is empty when nothing is saved", () => {
    expect(parseDeckSettings(undefined)).toEqual({ roles: {} });
    expect(parseDeckSettings(null)).toEqual({ roles: {} });
    expect(parseDeckSettings("")).toEqual({ roles: {} });
  });

  test("is empty for malformed content", () => {
    expect(parseDeckSettings("not json")).toEqual({ roles: {} });
    expect(parseDeckSettings("[]")).toEqual({ roles: {} });
    expect(parseDeckSettings(JSON.stringify({ roles: "nope" }))).toEqual({ roles: {} });
  });

  test("drops non-string role mappings", () => {
    const content = JSON.stringify({ roles: { budget_approver: "art_1", technical_approver: 42 } });
    expect(parseDeckSettings(content)).toEqual({ roles: { budget_approver: "art_1" } });
  });

  test("round-trips through deckSettingsContent", () => {
    const settings = { roles: { budget_approver: "art_1" } };
    expect(parseDeckSettings(deckSettingsContent(settings))).toEqual(settings);
  });
});

describe("withRoleTemplate", () => {
  test("maps a role to a template", () => {
    const next = withRoleTemplate({ roles: {} }, "budget_approver", "art_1");
    expect(next).toEqual({ roles: { budget_approver: "art_1" } });
  });

  test("updates an existing mapping", () => {
    const next = withRoleTemplate({ roles: { budget_approver: "art_1" } }, "budget_approver", "art_2");
    expect(next).toEqual({ roles: { budget_approver: "art_2" } });
  });

  test("removes a role's mapping when given null", () => {
    const next = withRoleTemplate({ roles: { budget_approver: "art_1", technical_approver: "art_2" } }, "budget_approver", null);
    expect(next).toEqual({ roles: { technical_approver: "art_2" } });
  });

  test("leaves other roles untouched", () => {
    const before = { roles: { technical_approver: "art_2" } };
    const next = withRoleTemplate(before, "budget_approver", "art_1");
    expect(next.roles.technical_approver).toBe("art_2");
    expect(before).toEqual({ roles: { technical_approver: "art_2" } });
  });
});

describe("slidesSource", () => {
  test("builds fresh when a theme is mapped, even over a recorded deck", () => {
    expect(slidesSource({ hasRecordedDeck: true, theme: { accent: "112233" } })).toBe("build");
  });

  test("keeps the recorded deck when no theme is mapped", () => {
    expect(slidesSource({ hasRecordedDeck: true, theme: null })).toBe("recorded");
  });

  test("builds when there is no recorded deck and no theme", () => {
    expect(slidesSource({ hasRecordedDeck: false, theme: null })).toBe("build");
  });
});
