import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;

function read(relative: string): string {
  return readFileSync(join(here, relative), "utf8");
}

describe("persist failure keeps a landed review visible", () => {
  test("panel persist does not flip status to error", () => {
    const source = read("./panel-reviews.tsx");
    const persist = source.slice(source.indexOf("await api.persistPanelReview"), source.indexOf("}, [reviews, projectId, stage, onDocumentsChanged, update]"));
    expect(persist).toContain("persistError");
    expect(persist).not.toContain('status: "error"');
    expect(source).toContain('what="Couldn\'t record the review"');
    expect(source).toContain("current.status === \"done\" && current.reply");
  });

  test("stage 6 persist does not flip status to error", () => {
    const source = read("./stage6.tsx");
    const persist = source.slice(source.indexOf("await api.persistEngineeringReview"), source.indexOf("}, [reviews, projectId, onDocumentsChanged]"));
    expect(persist).toContain("persistError");
    expect(persist).not.toContain('status: "error"');
    expect(source).toContain("current.status === \"done\" && current.reply");
  });
});

describe("delivery verification select never throws", () => {
  test("select uses parseDeliveryVerificationJson, not JSON.parse", () => {
    const delivery = read("./delivery.tsx");
    expect(delivery).toContain("parseDeliveryVerificationJson");
    expect(delivery).not.toContain("JSON.parse(content)");
    expect(delivery).toContain("verificationRecordUnreadable");
    expect(delivery).toContain('what="Couldn\'t load the verification record"');
  });
});

describe("opening FailedRead names a read as a read", () => {
  test("index uses the dispatch's errorWhat, not a hardcoded send line", () => {
    const index = read("./index.tsx");
    expect(index).toContain("what={openingDispatch.errorWhat}");
    expect(index).not.toContain('what="Couldn\'t send the opening message"');
  });
});

describe("recovery read can retry", () => {
  test("panel recovery does not mark recovered until the read succeeds, and Try again clears it", () => {
    const source = read("./panel-reviews.tsx");
    const recovery = source.slice(source.indexOf("const recoveredFor = useRef(new Set<string>())"), source.indexOf("// A reply that lands is recorded"));
    expect(recovery).toContain("recoveringFor.current.add(node.id)");
    expect(recovery).not.toMatch(/recoveredFor\.current\.add\(node\.id\);\s*void/);
    expect(recovery).toContain("recoveredFor.current.add(node.id)");
    expect(source).toContain('label: "Try again"');
    expect(source).toContain("recoveredFor.current.delete(node.id)");
  });

  test("stage 6 requirements recovery does not mark recovered until the read succeeds, and Try again re-enters", () => {
    const source = read("./stage6.tsx");
    const recovery = source.slice(source.indexOf("const recoveredFor = useRef<string | null>(null)"), source.indexOf("const reviewRecoveredFor"));
    expect(recovery).toContain("recoveringFor.current = requirementsNode.id");
    expect(recovery).not.toContain("recoveredFor.current = requirementsNode.id;\n      const nodeId");
    expect(recovery).toContain("recoveredFor.current = nodeId");
    expect(source).toContain("recoveredFor.current = null");
    expect(source).toContain('label: "Try again"');
  });
});
