import { describe, expect, test } from "bun:test";
import type { StackRecord } from "@solutions-builder/app/stack";
import { renderStackBlock } from "./frozen-stack-text.ts";

const CHOICE = { reason: "because", cites: ["FR-1"] };
const STACK: StackRecord = {
  mode: "inference",
  runtime: { ...CHOICE, choice: "Capacitor iOS shell over a TypeScript/React app, built with Bun and Xcode" },
  ui: null,
  storage: null,
  auth: null,
  packaging: { ...CHOICE, choice: "Xcode-built iOS app, signed with your paid developer account, installed from your Mac", kind: "compiled-binary" },
  packages: [],
  deferred: [],
};

describe("renderStackBlock", () => {
  // #882: the worker's packet ends on the target in the person's words; the
  // frozen choices beside it say what that means for this build, so "an
  // app you install" and a phone-only plan never read as a conflict.
  test("carries the frozen runtime and packaging choices beside how it runs", () => {
    const block = renderStackBlock({ stack: STACK });
    expect(block).toContain("## How it will run");
    expect(block).toContain("- Built with: Capacitor iOS shell over a TypeScript/React app, built with Bun and Xcode");
    expect(block).toContain("- Ships as: Xcode-built iOS app, signed with your paid developer account, installed from your Mac");
    expect(block).not.toContain("desktop");
  });

  test("no freeze, no block", () => {
    expect(renderStackBlock(null)).toBeNull();
  });
});
