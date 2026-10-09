import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

// #570: a workspace read that fails is shown with its reason and a Try
// again, never read as "nothing there". Each item is one screen.
describe("a workspace read that fails is shown", () => {
  test("tracked changes say when the previous version could not be read", () => {
    const document = read("document.tsx");
    expect(document).not.toContain(".catch(() => {})");
    expect(document).toContain("setPreviousError(failureReason(cause))");
    expect(document).toMatch(/<FailedRead[\s\S]*?what=\{`Changes since v\$\{previous\.position\} cannot be shown/);
  });

  test("the withdrawn-turn marker's failure is shown over the composer, with Try again", () => {
    const hook = read("use-withdrawn-turns.ts");
    expect(hook).not.toContain(".catch(() => {})");
    expect(hook).toContain("setError(failureReason(cause))");
    const index = read("index.tsx");
    expect(index).toMatch(/withdrawn\.error \?[\s\S]*?<FailedRead[\s\S]*?onRetry=\{withdrawn\.retry\}/);
  });

  test("the delivery pane never reads a failed read as a missing record or an undelivered build", () => {
    const delivery = read("delivery.tsx");
    expect(delivery).not.toContain("parseDeliveryVerification(undefined)");
    expect(delivery).not.toContain(".catch(() => null)");
    expect(delivery).toContain('what="The verification record could not be read"');
  });

  test("the project workflow's first read and its poll keep their reason", () => {
    const hook = read("use-workflow-view.ts");
    const reload = hook.slice(hook.indexOf("const reload = useMemo("), hook.indexOf("const refresh = useCallback("));
    expect(reload).not.toContain(".catch(() => null)");
    expect(reload).toContain("setReloadError(describeFailure(cause))");
    expect(hook).toContain("setViewError(describeFailure(cause))");
    const index = read("index.tsx");
    expect(index).toContain("{workflow.startError ?? workflow.viewError}");
    expect(index).toMatch(/workflow\.reloadError \?[\s\S]*?onRetry=\{\(\) => void workflow\.reload\(\)\}/);
  });

  test("Deliver's opening is composed from reads that may fail, never from a swallowed one", () => {
    expect(read("stage9-opening.ts")).not.toContain("} catch {");
  });
});
