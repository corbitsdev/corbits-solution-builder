import { createHash as nodeCreateHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createHash } from "../node-crypto.ts";

describe("browser createHash stand-in", () => {
  test("matches node:crypto sha256 hex for empty, abc, and NUL-framed paths", () => {
    for (const chunks of [[""], ["abc"], ["path", "\0", "body", "\0"], ["a", "b", "c"]]) {
      const expected = nodeCreateHash("sha256");
      const actual = createHash("sha256");
      for (const chunk of chunks) {
        expected.update(chunk);
        actual.update(chunk);
      }
      expect(actual.digest("hex")).toBe(expected.digest("hex"));
    }
  });
});
