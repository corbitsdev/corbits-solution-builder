/**
 * Fixture run by `deck.test.ts` in a fresh process: it removes Node's
 * `Buffer` *before* importing anything, the way the browser export path and
 * the workflow-child sandbox look to JSZip/pptxgenjs at module load (their
 * platform support is snapshotted on import). It then renders a text-only
 * deck and one with a cover picture and checks both are real zips.
 *
 * Exit 0 with "OK <textBytes> <imageBytes>" on stdout when both render;
 * any failure throws, which Bun reports on stderr with a non-zero exit.
 */
const holder = globalThis as unknown as Record<string, unknown>;
holder["Buffer"] = undefined;

const { deckFrom, renderDeck } = await import("./deck.js");

const OUTLINE = `### Deck outline

1. **The problem** — Costs are rising faster than revenue. It compounds monthly.
2. **The plan** — Ship the pilot in Q1. It is scoped tight.

### Decision request

- Approve the pilot budget.
`;

const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const check = (bytes: Uint8Array, label: string): void => {
  if (bytes.length <= 100 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(`${label} did not render as a zip (${String(bytes.length)} bytes)`);
  }
};

const plain = deckFrom({ projectTitle: "Acme", audience: "Finance", role: "Approver", markdown: OUTLINE });
if (!plain) throw new Error("outline did not parse");
const textBytes = await renderDeck(plain);
check(textBytes, "text-only deck");
const imageBytes = await renderDeck({ ...plain, images: new Map([["cover", PNG_1X1]]) });
check(imageBytes, "deck with a cover picture");

console.log(`OK ${String(textBytes.length)} ${String(imageBytes.length)}`);
