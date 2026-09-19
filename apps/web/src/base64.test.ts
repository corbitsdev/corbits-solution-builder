import { describe, expect, test } from "bun:test";
import { toBase64 } from "./base64.ts";

describe("toBase64", () => {
  test("round-trips a 3 MB buffer without blowing the call stack", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const encoded = toBase64(bytes);
    const decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  test("matches btoa on a small input", () => {
    const bytes = new TextEncoder().encode("hello world");
    expect(toBase64(bytes)).toBe(btoa("hello world"));
  });
});
