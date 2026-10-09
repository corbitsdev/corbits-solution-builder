/**
 * What the stage 5 specialist is asked for a stakeholder's package, with
 * what it needs to answer. The request itself names the audience, by name
 * and role (#41 step 3): the one presentation-creator deployment serves
 * every stakeholder, its prompt names none of them, and a stakeholder
 * added or renamed after the stage opened is asked for as named now, with
 * no redeploy. It also carries the approved design the packages are built
 * on (#115): the specialist's opening turn may be pages back, or on an
 * earlier deployment's thread after a redeploy, and without the design here
 * it can only ask for it to be pasted. And it carries the deck's brief
 * (#246): the design guidelines that apply to this project, since the
 * specialist's prompt is fixed at deploy and the mail is the only place a
 * project's own instruction can reach it. The look is the interface's to
 * apply when it draws the slides (#285), so none of it rides here.
 */
import { packageOutlineProblem } from "@solutions-builder/app/deck";
import type { DeckBrief } from "./deck-design-documents.ts";
import { designHandoff } from "./design-handoff.ts";

/** What a stakeholder told the Presentation creator at Concept approval (#722); the package is written to it. */
export type PackageInterview = readonly { readonly question: string; readonly answer: string }[];

export type PackageAudience = { readonly name: string; readonly role: string; readonly interview?: PackageInterview };

/** The first line of the request for `name`'s package: what the specialist
 *  is told to write, and what `packageReplyFor` finds the request by. */
export function packageAsk(name: string): string {
  return `Write the package for: ${name}`;
}

/** A role id as a person (or a model) reads it: `budget_approver` → "budget approver". */
function roleLabel(role: string): string {
  return role.replace(/_/g, " ");
}

/**
 * Why a reply to `packageAsk(name)` is not `name`'s package, or null when it
 * is one (#220). The presentation creator's prompt says a package without a
 * deck outline is refused and nothing is recorded; the page holds the reply
 * to that before recording it, since an acknowledgement, a question or a
 * claim that a deck was rendered is not a package, and recording one left a
 * stakeholder with a "package" no slides could be built from.
 */
export function packageReplyProblem(name: string, body: string): string | null {
  const problem = packageOutlineProblem(body);
  return problem ? `${name}'s package was not written: the reply ${problem}. Ask for it again.` : null;
}

/**
 * The one follow-up sent when a reply to `packageAsk(name)` was not a
 * package (#225): what was missing and where the package has to be. Opens
 * with the same ask line, so the reply to it is found the same way.
 */
export function packageNudge(audience: PackageAudience, problem: string): string {
  return `${packageAsk(audience.name)}, the ${roleLabel(audience.role)} — again, as the reply itself.\n\nYour last reply was not the package: ${problem}. Reply with the package: the status line, then the five headed sections in Markdown, with the deck outline as numbered slides, in this reply. Markdown handed to render_deck is not read as the package.`;
}

/** Everyone the Concept approval decision rests with, and how many of them must proceed. */
export type PackageRoster = { readonly audiences: readonly PackageAudience[]; readonly quorum: number };

/** The roster off a project's policy, however old the record: entries with a name and a role, and the quorum. */
export function rosterOf(policy: unknown): PackageRoster {
  const record = typeof policy === "object" && policy !== null ? (policy as Record<string, unknown>) : {};
  const audiences: PackageAudience[] = Array.isArray(record.audiences)
    ? record.audiences.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return [];
        const { name, role, interview } = entry as Record<string, unknown>;
        if (typeof name !== "string" || typeof role !== "string") return [];
        const said = Array.isArray(interview)
          ? interview.flatMap((item: unknown) => {
              const pair = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
              return typeof pair.question === "string" && typeof pair.answer === "string" ? [{ question: pair.question, answer: pair.answer }] : [];
            })
          : [];
        return [{ name, role, ...(said.length > 0 ? { interview: said } : {}) }];
      })
    : [];
  return { audiences, quorum: typeof record.audienceQuorum === "number" ? record.audienceQuorum : 0 };
}

/** The roster as the request states it (#690), so the specialist never takes one reader for the only approver. */
export function rosterLine(audience: PackageAudience, roster: PackageRoster): string | null {
  const others = roster.audiences.filter((entry) => entry.name !== audience.name);
  if (others.length === 0) return null;
  const everyone = roster.audiences.map((entry) => `${entry.name} (${roleLabel(entry.role)})`).join(", ");
  const needed = roster.quorum > 0 ? `${String(roster.quorum)} of them must proceed` : "each decides for themselves";
  return `The decision does not rest with ${audience.name} alone: the stakeholders are ${everyone}; ${needed}. This package is for ${audience.name} only; the others get packages of their own, so write to ${audience.name} and never call them the sole decision-maker.`;
}

/** What the reader told us at Concept approval, for the specialist to write to (#722); null when they were not asked. */
export function interviewSection(audience: PackageAudience): string | null {
  const interview = audience.interview ?? [];
  if (interview.length === 0) return null;
  const lines = interview.map((entry) => `- ${entry.question}\n  ${entry.answer}`);
  return `What ${audience.name} told us, asked before this package was written; write the package to it:\n${lines.join("\n")}`;
}

export function packageRequest(audience: PackageAudience, design: string | null, brief: DeckBrief | null = null, roster: PackageRoster | null = null): string {
  const parts = [`${packageAsk(audience.name)}, the ${roleLabel(audience.role)}.`];
  const who = roster ? rosterLine(audience, roster) : null;
  if (who) parts.push(who);
  const said = interviewSection(audience);
  if (said) parts.push(said);
  // An HTML mockup goes over as its text, not its markup (#219): mailed
  // verbatim, the model answered with HTML instead of a Markdown package.
  if (design && design.trim()) parts.push(`The approved GUI design this package is built on, for reference:\n\n${designHandoff(design)}`);
  if (brief?.guidelines) parts.push(brief.guidelines);
  return parts.join("\n\n");
}
