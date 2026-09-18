import { describe, expect, test } from "bun:test";
import { SIDECAR_WS_PATH, createEmbeddedHub } from "./index.js";

describe("@solutions-builder/embed-hub", () => {
  test("exports the sidecar socket path createApp serves", () => {
    expect(SIDECAR_WS_PATH).toBe("/api/sidecars/ws");
  });

  test("createEmbeddedHub is the composition entry, not a product API", () => {
    expect(typeof createEmbeddedHub).toBe("function");
  });
});
