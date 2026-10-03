import { describe, expect, test } from "bun:test";
import { materialToSend } from "./use-material-dispatch.ts";
import type { ChainNode } from "./approved-chain.ts";
import type { ChatMessage } from "../../stage-mail.ts";

const reading: ChainNode = {
  id: "reading",
  kind: "material_reading",
  stage: 1,
  title: "deck.pdf (reading)",
  artifactId: "art_reading",
  version: 1,
  variant: "deck.pdf",
  supersededByNodeId: null,
  createdAt: "2026-01-01T00:10:00.000Z",
  mediaType: "text/plain",
};

const thread: ChatMessage[] = [
  { id: "m1", author: "me", body: "Make leads easier.", at: "2026-01-01T00:05:00.000Z" },
  { id: "m2", author: "agent", body: "## In short\n- leads", at: "2026-01-01T00:06:00.000Z" },
];

const ready = { agentAddress: "a@x", addresses: ["a@x"], loadedFor: "a@x", busy: false, nodes: [reading], messages: thread };

describe("materialToSend", () => {
  test("a file attached to a stage under way is sent once the specialist is idle", () => {
    expect(materialToSend(ready).map((node) => node.id)).toEqual(["reading"]);
  });

  test("it waits for the specialist's address, for the thread to have loaded for it, and for a turn in flight", () => {
    expect(materialToSend({ ...ready, agentAddress: null })).toEqual([]);
    expect(materialToSend({ ...ready, loadedFor: null })).toEqual([]);
    expect(materialToSend({ ...ready, loadedFor: "old@x" })).toEqual([]);
    expect(materialToSend({ ...ready, busy: true })).toEqual([]);
  });

  test("an empty thread is the opening's to fill, material included", () => {
    expect(materialToSend({ ...ready, messages: [] })).toEqual([]);
  });

  test("a redeployed specialist is handed the conversation first", () => {
    // The stage's mail lives at an earlier address and nothing has carried it to the live one yet.
    expect(materialToSend({ ...ready, agentAddress: "b@x", loadedFor: "b@x", addresses: ["a@x", "b@x"] })).toEqual([]);
  });
});
