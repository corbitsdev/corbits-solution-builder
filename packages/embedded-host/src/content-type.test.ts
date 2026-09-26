import { describe, expect, test } from "bun:test";
import { contentTypeFor } from "./serve.ts";

// #107: the busy indicator's film and poster ship beside the bundle; served
// as octet-stream a browser never decodes them into a <video>.
describe("contentTypeFor", () => {
  test("the bundle's own kinds", () => {
    expect(contentTypeFor("/dist/index.html")).toBe("text/html");
    expect(contentTypeFor("/dist/assets/index-abc.js")).toBe("text/javascript");
    expect(contentTypeFor("/dist/assets/index-abc.css")).toBe("text/css");
    expect(contentTypeFor("/dist/fonts/space-mono-400.woff2")).toBe("font/woff2");
  });

  test("the film and its poster", () => {
    expect(contentTypeFor("/dist/zen-garden.mp4")).toBe("video/mp4");
    expect(contentTypeFor("/dist/zen-garden-poster.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("/dist/still.png")).toBe("image/png");
  });

  test("anything else is opaque bytes", () => {
    expect(contentTypeFor("/dist/closure/manifest.tgz")).toBe("application/octet-stream");
  });
});
