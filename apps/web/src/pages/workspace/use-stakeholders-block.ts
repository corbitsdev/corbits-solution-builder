/**
 * What the Presentation creator settles in the Concept approval chat, saved
 * onto the project's stakeholders (#722). Its reply to "Who needs to approve
 * to move forward?" carries a fenced ```json stakeholders block, and each
 * approver's interview a ```json stakeholder-interview block
 * (`stakeholders-block.ts`). The latest roster not yet applied, and every
 * interview recorded after it that is not, are saved in order through
 * `api.setStakeholders`, the one path every stakeholder edit takes, and the
 * caller is told of each so the panel refreshes, the review recaptures the
 * policy and a sole approver's package is written. Applied message ids are
 * kept in localStorage by project, so a reload does not save the same reply
 * again. A save that fails is shown with its reason and Try again (#570),
 * never dropped: the person would otherwise see the specialist confirm a
 * roster the panel never shows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../../client.js";
import { rosterOf, type PackageRoster } from "../../package-request.ts";
import type { ChatMessage } from "../../stage-mail.ts";
import { interviewBlockOf, stakeholdersBlockOf, type InterviewBlock, type StakeholdersBlock } from "../../stakeholders-block.ts";
import type { SavedStakeholders } from "../audiences.jsx";

export type StakeholdersBlockFailure = { readonly what: string; readonly detail: string };

export type PendingBlock =
  | { readonly id: string; readonly kind: "roster"; readonly roster: StakeholdersBlock }
  | { readonly id: string; readonly kind: "interview"; readonly interview: InterviewBlock };

/**
 * What the thread still has to apply, oldest first: the latest roster the
 * specialist confirmed, unless applied, then every interview recorded after
 * it that is not. Only the latest roster counts, since a reply before it was
 * superseded, not left to save; an interview recorded before that roster was
 * confirmed is superseded with it, the entry it named being whatever the
 * later roster says.
 */
export function blocksToApply(messages: readonly ChatMessage[], applied: ReadonlySet<string>): PendingBlock[] {
  let latestRoster: { readonly index: number; readonly id: string; readonly roster: StakeholdersBlock } | null = null;
  const interviews: { readonly index: number; readonly id: string; readonly interview: InterviewBlock }[] = [];
  messages.forEach((message, index) => {
    if (message.author !== "agent") return;
    const roster = stakeholdersBlockOf(message.body);
    if (roster) {
      latestRoster = { index, id: message.id, roster };
      return;
    }
    const interview = interviewBlockOf(message.body);
    if (interview) interviews.push({ index, id: message.id, interview });
  });
  const pending: PendingBlock[] = [];
  const roster = latestRoster as { readonly index: number; readonly id: string; readonly roster: StakeholdersBlock } | null;
  if (roster && !applied.has(roster.id)) pending.push({ id: roster.id, kind: "roster", roster: roster.roster });
  for (const entry of interviews) {
    if (roster && entry.index < roster.index) continue;
    if (!applied.has(entry.id)) pending.push({ id: entry.id, kind: "interview", interview: entry.interview });
  }
  return pending;
}

/** Whether the policy already holds this roster, name for name, role for role, in order. */
export function sameRoster(current: PackageRoster, block: StakeholdersBlock): boolean {
  if (current.quorum !== block.quorum || current.audiences.length !== block.audiences.length) return false;
  return current.audiences.every((entry, index) => entry.name === block.audiences[index]!.name && entry.role === block.audiences[index]!.role);
}

/** The policy with `block`'s interview on the entry it names, other entries untouched; null when no entry has that name. */
export function withInterview(current: PackageRoster, block: InterviewBlock): { audiences: SavedStakeholders["audiences"]; audienceQuorum: number } | null {
  const wanted = block.name.trim().toLowerCase();
  if (!current.audiences.some((entry) => entry.name.trim().toLowerCase() === wanted)) return null;
  return {
    audiences: current.audiences.map((entry) => (entry.name.trim().toLowerCase() === wanted ? { ...entry, interview: block.interview } : entry)),
    audienceQuorum: current.quorum,
  };
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

function failureOf(block: PendingBlock, cause: unknown): StakeholdersBlockFailure {
  const detail = cause instanceof ApiFailure ? cause.detail.message : cause instanceof Error ? cause.message : String(cause);
  return block.kind === "roster"
    ? { what: "The stakeholders the Presentation creator confirmed could not be saved", detail }
    : { what: `${block.interview.name}'s interview could not be saved`, detail };
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
  /** The project's policy as the page holds it, so a roster already on record is not written again and an interview lands on it. */
  policy: unknown;
  /** Each save as it lands, and what it was: the roster, or one approver's interview. */
  onSaved: (saved: SavedStakeholders, kind: PendingBlock["kind"]) => void;
}): { readonly failure: StakeholdersBlockFailure | null; readonly retry: () => void } {
  const [failure, setFailure] = useState<StakeholdersBlockFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const appliedRef = useRef<{ projectId: string; ids: Set<string> } | null>(null);
  const inFlightRef = useRef(false);
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
    const pending = blocksToApply(messages, applied);
    if (pending.length === 0 || inFlightRef.current || failedForRef.current === pending[0]!.id) return;
    inFlightRef.current = true;
    let cancelled = false;
    const markApplied = (id: string) => {
      applied.add(id);
      saveApplied(projectId, applied);
    };
    void (async () => {
      // Each save works from the roster the one before it left, not the
      // page's policy, which refreshes after.
      let current = rosterOf(policy);
      for (const block of pending) {
        if (cancelled) return;
        try {
          let saved: SavedStakeholders;
          if (block.kind === "roster") {
            const payload = { audiences: block.roster.audiences.map((entry) => ({ ...entry })), audienceQuorum: block.roster.quorum };
            // The same roster is not written twice; the save's listeners
            // still hear it, so "Just me" on a project already down as
            // "You" alone goes on to the interview and the one package.
            saved = sameRoster(current, block.roster) ? { ...payload, audiences: current.audiences } : await api.setStakeholders(projectId, payload);
          } else {
            const payload = withInterview(current, block.interview);
            if (!payload) throw new Error(`no stakeholder named ${block.interview.name} is on record; add them under Manage stakeholders, then try again`);
            saved = await api.setStakeholders(projectId, payload);
          }
          if (cancelled) return;
          current = { audiences: saved.audiences, quorum: saved.audienceQuorum };
          markApplied(block.id);
          setFailure(null);
          onSavedRef.current(saved, block.kind);
        } catch (cause) {
          if (cancelled) return;
          failedForRef.current = block.id;
          setFailure(failureOf(block, cause));
          return;
        }
      }
    })().finally(() => {
      inFlightRef.current = false;
    });
    return () => {
      cancelled = true;
    };
    // `policy` is read when a save is due, not a reason to look for one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage, messages, attempt]);

  return { failure, retry };
}
