import { describe, expect, test } from "bun:test";
import { anchorLabel, looksLikeHtmlDocument } from "./design.tsx";

describe("anchorLabel", () => {
  test("prefers a stable test id over a DOM path", () => {
    expect(anchorLabel({ testId: "hero", domPath: "div:nth-child(1)" })).toBe("#hero");
  });
});

describe("looksLikeHtmlDocument", () => {
  test("a compliant self-contained mockup is HTML", () => {
    expect(looksLikeHtmlDocument("<!doctype html>\n<html><body>hi</body></html>")).toBe(true);
    expect(looksLikeHtmlDocument("  <html>\n<body>hi</body></html>")).toBe(true);
  });

  test("a qwen-shaped markdown reply — the kit asked for HTML only — is not", () => {
    const reply = [
      "## Chosen approach: Centralized Booking System",
      "",
      "The chosen approach is a centralized booking system that provides a",
      "streamlined experience for customers to book appointments and ensures",
      "stylists receive accurate notifications.",
      "",
      "## Approach A: Centralized Booking System",
      "### How it works",
      "- A centralized web application allows customers to book appointments.",
    ].join("\n");
    expect(looksLikeHtmlDocument(reply)).toBe(false);
  });
});
