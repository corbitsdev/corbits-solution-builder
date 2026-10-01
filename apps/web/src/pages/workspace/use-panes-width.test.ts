import { describe, expect, test } from "bun:test";
import { DOCUMENT_MIN_WIDTH, PANES_MAX_WIDTH, PANES_MIN_WIDTH, chatMaxWidth, clampChatWidth } from "./use-panes-width.ts";

// #343: the splitter's ceiling follows the panes' own width, so it grows on a
// wide window and cannot push the grid past the frame on a narrow one.
describe("chatMaxWidth and clampChatWidth", () => {
  test("without a measured container the ceiling is the flat fallback", () => {
    expect(chatMaxWidth(null)).toBe(PANES_MAX_WIDTH);
    expect(clampChatWidth(900, null)).toBe(PANES_MAX_WIDTH);
    expect(clampChatWidth(100, null)).toBe(PANES_MIN_WIDTH);
  });

  test("a wide window lets the chat grow past 720px, to 70% of the panes", () => {
    expect(chatMaxWidth(1500)).toBe(1050);
    expect(clampChatWidth(900, 1500)).toBe(900);
  });

  test("a narrow window keeps the document its minimum, and never less than the chat's own floor", () => {
    expect(chatMaxWidth(1000)).toBe(1000 - DOCUMENT_MIN_WIDTH);
    expect(clampChatWidth(720, 1000)).toBe(640);
    expect(chatMaxWidth(500)).toBe(PANES_MIN_WIDTH);
  });
});
