/**
 * Drafts as they are being written.
 *
 * The model streams its text token by token; until it finishes nothing is
 * recorded, so a reader watching the document pane sees nothing for a minute
 * and then everything. This holds the partial text of each in-flight draft,
 * keyed by project and stage, so the pane can show the document being written.
 *
 * In memory only: a partial draft is not an artifact, is never approved, and
 * a host restart should forget it.
 *
 * `attachLiveDrafts` below is the one feeder: it reads a project's own run —
 * the sidecar's inference events for the agent step a round just started —
 * and calls `beginLiveDraft`/`updateLiveDraft`/`endLiveDraft` from those,
 * never from a provider call this module or its caller makes itself.
 */
import { parseRunAddress } from "@intx/types";
import { hub } from "./hub-mount.js";
import { projectForAnchor } from "./lifecycle-run.js";

type Listener = (event: LiveEvent) => void;

export type LiveEvent =
  | { type: "begin" }
  | { type: "text"; text: string }
  | { type: "done" };

/** `begun` is true from the first call until text or done: the model is working. */
type Live = { text: string; begun: boolean; listeners: Set<Listener> };

const drafts = new Map<string, Live>();

const keyOf = (projectId: string, stage: number) => `${projectId}:${stage}`;

export function beginLiveDraft(projectId: string, stage: number): void {
  const key = keyOf(projectId, stage);
  const live = drafts.get(key) ?? { text: "", begun: false, listeners: new Set<Listener>() };
  drafts.set(key, live);
  live.text = "";
  live.begun = true;
  for (const listener of live.listeners) listener({ type: "begin" });
}

export function updateLiveDraft(projectId: string, stage: number, text: string): void {
  const live = drafts.get(keyOf(projectId, stage));
  if (!live) return;
  live.text = text;
  for (const listener of live.listeners) listener({ type: "text", text });
}

export function endLiveDraft(projectId: string, stage: number): void {
  const key = keyOf(projectId, stage);
  const live = drafts.get(key);
  if (!live) return;
  for (const listener of live.listeners) listener({ type: "done" });
  // Subscribers stay: the next draft on this stage reuses the entry.
  live.text = "";
  live.begun = false;
}

/** Current partial text, or null when nothing is being written. */
export function liveDraft(projectId: string, stage: number): string | null {
  const live = drafts.get(keyOf(projectId, stage));
  return live && live.text.length > 0 ? live.text : null;
}

/** Whether a draft is in flight with nothing written yet. */
export function liveDraftBegun(projectId: string, stage: number): boolean {
  return drafts.get(keyOf(projectId, stage))?.begun ?? false;
}

export function subscribeLiveDraft(projectId: string, stage: number, listener: Listener): () => void {
  const key = keyOf(projectId, stage);
  let live = drafts.get(key);
  if (!live) {
    live = { text: "", begun: false, listeners: new Set() };
    drafts.set(key, live);
  }
  live.listeners.add(listener);
  return () => {
    live!.listeners.delete(listener);
  };
}

/**
 * Models wrap output in a code fence even when told not to. Stripping one
 * outer fence is a kindness to the reader, not a licence to reinterpret the
 * draft: nothing else about the text is touched. Shared by both feeders so a
 * partial draft and its finished artifact are cleaned the same way.
 */
export function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

// --- Feeding live drafts from a run's own inference events ------------------

/**
 * Which stage a project's next inference cycle belongs to, set by the host
 * just before it asks the run to draft. The sidecar relays every inference
 * cycle on the run — the specialist's, and later a reviewer's or evaluator's
 * — as `agent.event` frames on the same address, and nothing on the wire
 * says which is which. This is how the caller tells them apart: only the
 * first cycle after the expectation is set streams as a live draft: it is
 * cleared as soon as that cycle ends, so a later cycle on the same run (a
 * reviewer or evaluator step) is not mistaken for a second draft.
 */
const expected = new Map<string, { stage: number; active: boolean }>();

export function expectLiveDraft(projectId: string, stage: number): void {
  expected.set(projectId, { stage, active: false });
}

/** Accumulated text for the cycle currently streaming, keyed by project. */
const accumulating = new Map<string, string>();

let attached = false;

/**
 * Subscribes once to the hub's sidecar events and feeds `live-drafts` from
 * whichever project's anchor run they name. Idempotent: a caller that mounts
 * the hub more than once in a process (a smoke, a hot reload) does not stack
 * a second listener.
 */
export function attachLiveDrafts(): void {
  if (attached) return;
  attached = true;
  hub().events.on("agent.event", ({ agentAddress, event }) => {
    const address = parseRunAddress(agentAddress);
    if (!address) return;
    const projectId = projectForAnchor(address.runId);
    if (!projectId) return;
    const expectation = expected.get(projectId);
    if (!expectation) return;

    const inference = event as { type?: unknown; data?: unknown };
    switch (inference.type) {
      case "inference.start": {
        if (expectation.active) return; // a later cycle on the same run; not the draft
        expectation.active = true;
        accumulating.set(projectId, "");
        beginLiveDraft(projectId, expectation.stage);
        return;
      }
      case "inference.text.delta": {
        if (!expectation.active) return;
        const data = inference.data as { token?: unknown } | undefined;
        const token = typeof data?.token === "string" ? data.token : "";
        const text = (accumulating.get(projectId) ?? "") + token;
        accumulating.set(projectId, text);
        updateLiveDraft(projectId, expectation.stage, stripOuterFence(text));
        return;
      }
      case "inference.done":
      case "connector.reply": {
        if (!expectation.active) return;
        endLiveDraft(projectId, expectation.stage);
        accumulating.delete(projectId);
        expected.delete(projectId);
        return;
      }
      default:
        return;
    }
  });
}
