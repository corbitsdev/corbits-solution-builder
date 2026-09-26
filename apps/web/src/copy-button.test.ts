import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const read = (relative: string) => readFileSync(join(here, relative), "utf8");

// #117: every artifact a person can read carries a Copy control.
describe("the Copy control", () => {
  test("puts the text on the clipboard and says so, or says it could not", () => {
    const components = read("./components.tsx");
    expect(components).toContain("await navigator.clipboard.writeText(text);");
    expect(components).toContain('{state === "copied" ? "Copied" : state === "failed" ? "Couldn\'t copy" : label}');
  });

  test("sits on the reader, the stage document, the design and a stakeholder package", () => {
    expect(read("./pages/workspace/index.tsx")).toContain("<CopyButton text={isDataUrl(artifacts.activeContent) ? null : artifacts.activeContent} />");
    expect(read("./pages/workspace/document.tsx")).toContain("{!binary ? <CopyButton text={content} /> : null}");
    expect(read("./pages/design.tsx")).toContain("<CopyButton text={content || null} />");
    expect(read("./pages/audiences.tsx")).toContain("<CopyButton text={content || null} />");
  });
});
