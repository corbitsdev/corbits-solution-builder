/**
 * The roster the Presentation creator confirms in the Concept approval chat,
 * saved as the project's stakeholders (#722). The specialist's reply to
 * "Who needs to approve to move forward?" carries a fenced
 * ```json stakeholders block (`stakeholders-block.ts`); the latest reply
 * holding a valid one that has not been applied is saved through
 * `api.setStakeholders`, the one path every stakeholder edit takes, and the
 * caller is told so the panel refreshes, the review recaptures the policy
 * and a sole approver's package is written. Applied message ids are kept in
 * localStorage by project, so a reload does not save the same reply again.
 * A save that fails is shown with its reason and Try again (#570), never
 * dropped: the person would otherwise see the specialist confirm a roster
 * the panel never shows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../../client.js";
import { rosterOf, type PackageRoster } from "../../package-request.ts";
import type { ChatMessage } from "../../stage-mail.ts";
import { stakeholdersBlockOf, type StakeholdersBlock } from "../../stakeholders-block.ts";
import type { SavedStakeholders } from "../audiences.jsx";

export type StakeholdersBlockFailure = { readonly what: string; readonly detail: string };

/**
 * The latest specialist reply carrying a valid roster, unless it has been
 * applied. Only the latest counts: a reply before it that was never applied
 * is superseded by it, not a second thing to save.
 */
export function rosterToApply(messages: readonly ChatMessage[], applied: ReadonlySet<string>): { readonly id: string; readonly roster: StakeholdersBlock } | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (message.author !== "agent") continue;
    const roster = stakeholdersBlockOf(message.body);
    if (!roster) continue;
    return applied.has(message.id) ? null : { id: message.id, roster };
  }
  return null;
}

/** Whether the policy already holds this roster, name for name, role for role, in order. */
export function sameRoster(current: PackageRoster, block: StakeholdersBlock): boolean {
  if (current.quorum !== block.quorum || current.audiences.length !== block.audiences.length) return false;
  return current.audiences.every((entry, index) => entry.name === block.audiences[index]!.name && entry.role === block.audiences[index]!.role);
}

function storageKey(projectId: string): string {
  return `sb.stakeholders-applied.${projectId}`;
}

export function loadApplied(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveApplied(projectId: string, applied: ReadonlySet<string>): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify([...applied]));
  } catch {
    // Best effort: without it a reload in this browser saves the same roster once more, which the policy absorbs.
  }
}

export function useStakeholdersBlock({
  projectId,
  stage,
  messages,
  policy,
  onSaved,
}: {
  projectId: string;
  stage: number;
  /** The stage's thread, opening included. */
  messages: readonly ChatMessage[];
  /** The project's policy as the page holds it, so a roster already on record is not written again. */
  policy: unknown;
  onSaved: (saved: SavedStakeholders) => void;
}): { readonly failure: StakeholdersBlockFailure | null; readonly retry: () => void } {
  const [failure, setFailure] = useState<StakeholdersBlockFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const appliedRef = useRef<{ projectId: string; ids: Set<string> } | null>(null);
  const inFlightRef = useRef<string | null>(null);
  // A save that failed is not tried again on every thread poll; only Try again clears this.
  const failedForRef = useRef<string | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const retry = useCallback(() => {
    failedForRef.current = null;
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (stage !== 5) return;
    if (appliedRef.current?.projectId !== projectId) appliedRef.current = { projectId, ids: loadApplied(projectId) };
    const applied = appliedRef.current.ids;
    const pending = rosterToApply(messages, applied);
    if (!pending || inFlightRef.current === pending.id || failedForRef.current === pending.id) return;
    inFlightRef.current = pending.id;
    let cancelled = false;
    const markApplied = () => {
      applied.add(pending.id);
      saveApplied(projectId, applied);
    };
    void (async () => {
      const current = rosterOf(policy);
      const payload = { audiences: pending.roster.audiences.map((entry) => ({ ...entry })), audienceQuorum: pending.roster.quorum };
      // The same roster is not written twice; the save's listeners still
      // hear it, so "Just me" on a project already down as "You" alone
      // writes the one package there is.
      const saved = sameRoster(current, pending.roster) ? payload : await api.setStakeholders(projectId, payload);
      if (cancelled) return;
      markApplied();
      setFailure(null);
      onSavedRef.current(saved);
    })()
      .catch((cause: unknown) => {
        if (cancelled) return;
        failedForRef.current = pending.id;
        setFailure({
          what: "The stakeholders the Presentation creator confirmed could not be saved",
          detail: cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        if (inFlightRef.current === pending.id) inFlightRef.current = null;
      });
    return () => {
      cancelled = true;
    };
    // `policy` is read when a save is due, not a reason to look for one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage, messages, attempt]);

  return { failure, retry };
}
