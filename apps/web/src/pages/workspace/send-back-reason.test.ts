import { describe, expect, test } from "bun:test";
import { composeSendBackReason } from "./send-back-reason.ts";

describe("composeSendBackReason", () => {
  test("is empty with nothing queued and nothing typed", () => {
    expect(composeSendBackReason([], "   ")).toBe("");
  });

  test("leads with the queued passages, each with its note, then the typed reason", () => {
    const reason = composeSendBackReason(
      [
        { quote: "Two tabs, not three.", note: "The owner said one." },
        { quote: "Export to PDF." },
      ],
      "  Please drop the third tab.  ",
    );
    expect(reason).toBe("> Two tabs, not three.\n— The owner said one.\n\n> Export to PDF.\n\nPlease drop the third tab.");
  });

  test("a typed reason alone goes as typed", () => {
    expect(composeSendBackReason([], "Wrong audience.")).toBe("Wrong audience.");
  });
});
