import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { controlText } from "./control-text.ts";

describe("controlText", () => {
  test("reads a control's words through fragments and elements, skipping icons", () => {
    expect(controlText("Writing…")).toBe("Writing…");
    expect(controlText(["Write all ", 3])).toBe("Write all 3");
    expect(controlText(createElement(Fragment, null, createElement("svg", { "aria-hidden": true }), " Save slides (.pptx)"))).toBe("Save slides (.pptx)");
    expect(controlText(createElement("span", null, "Approve ", createElement("b", null, "and continue")))).toBe("Approve and continue");
  });

  test("is null for a control with no words", () => {
    expect(controlText(null)).toBeNull();
    expect(controlText(createElement("svg", null))).toBeNull();
    expect(controlText("   ")).toBeNull();
  });
});
