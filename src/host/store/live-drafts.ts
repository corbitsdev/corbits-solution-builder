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
 */
type Listener = (event: LiveEvent) => void;

export type LiveEvent =
  | { type: "text"; text: string }
  | { type: "done" };

type Live = { text: string; listeners: Set<Listener> };

const drafts = new Map<string, Live>();

const keyOf = (projectId: string, stage: number) => `${projectId}:${stage}`;

export function beginLiveDraft(projectId: string, stage: number): void {
  const key = keyOf(projectId, stage);
  const existing = drafts.get(key);
  if (existing) {
    existing.text = "";
    return;
  }
  drafts.set(key, { text: "", listeners: new Set() });
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
}

/** Current partial text, or null when nothing is being written. */
export function liveDraft(projectId: string, stage: number): string | null {
  const live = drafts.get(keyOf(projectId, stage));
  return live && live.text.length > 0 ? live.text : null;
}

export function subscribeLiveDraft(projectId: string, stage: number, listener: Listener): () => void {
  const key = keyOf(projectId, stage);
  let live = drafts.get(key);
  if (!live) {
    live = { text: "", listeners: new Set() };
    drafts.set(key, live);
  }
  live.listeners.add(listener);
  return () => {
    live!.listeners.delete(listener);
  };
}
