/**
 * Mail the app composes in the person's name, and how the chat shows it
 * (#429). A stage's opening, a send-back cue, a requirement-ids block and
 * the material attached after an opening (#607) are written for the
 * specialist; read back in the chat as the person's
 * own words they are a page of hashes, a plan, or a marker. Alpha main's
 * prompt never reached the chat at all. Here each such mail folds behind
 * one line, and a marker a person never typed is not shown.
 *
 * Pure: the rule is testable without the thread, and the thread only
 * renders what this returns.
 */
import type { ChatMessage } from "../../stage-mail.ts";
import { stageName } from "../../components.jsx";
import { REQUIREMENTS_BLOCK_HEADING } from "@solutions-builder/app/requirements";
import { isOwner, type PackageAudience } from "../../package-request.ts";
import { namedTogether, splitMaterialMail } from "./attached-material.ts";

export type ComposedFold = {
  /** The one line the chat shows; null when nothing folds and only `lead` shows. */
  readonly summary: string | null;
  /** What opens under the summary, markers removed. */
  readonly body: string;
  /** A line shown outside the fold: the cue's or the ask's own sentence. */
  readonly lead: string | null;
};

const OPENING_SUBJECT = /^\[opening:[^\]]+:(\d+)\]/;
const SEND_BACK_REF = /\s*\[ref:[^\]]+\]\s*$/;

/** The send-back cue's sentence, its marker gone. */
export function withoutSendBackRef(body: string): string {
  return body.replace(SEND_BACK_REF, "").trimEnd();
}

/** A leading requirement-ids block and what follows it. */
function splitIdsBlock(text: string): { readonly ids: string; readonly rest: string } {
  const lines = text.split("\n");
  let end = lines.length;
  for (let at = 1; at < lines.length; at += 1) {
    if (lines[at]!.trim() === "" && at + 1 < lines.length && !lines[at + 1]!.startsWith("- ") && lines[at + 1]!.trim() !== "(None minted yet.)") {
      end = at;
      break;
    }
  }
  return { ids: lines.slice(0, end).join("\n").trim(), rest: lines.slice(end).join("\n").trim() };
}

/**
 * The fold for material attached after the opening (#607), or null for any
 * other body: the chat names the files and keeps what they say behind the
 * fold, the markers with it. For a body already known to be the person's.
 */
export function materialMailFold(body: string): ComposedFold | null {
  const material = splitMaterialMail(body);
  if (!material) return null;
  return { summary: "What the attached material says", body: material.material, lead: `Attached ${namedTogether(material.names) || "material"}.` };
}

/**
 * The fold for a person-authored message the app composed, or null for a
 * message the person wrote. Only `author === "me"` is ever inspected, so
 * nothing a specialist writes can be folded away by echoing a marker.
 */
export function composedMailFold(message: Pick<ChatMessage, "author" | "body" | "subject">): ComposedFold | null {
  if (message.author !== "me") return null;
  const opening = message.subject ? OPENING_SUBJECT.exec(message.subject) : null;
  if (opening) {
    return { summary: `What ${stageName(Number(opening[1]!))} opened with`, body: withoutSendBackRef(message.body), lead: null };
  }
  const material = materialMailFold(message.body);
  if (material) return material;
  const isCue = SEND_BACK_REF.test(message.body);
  const hasIds = message.body.startsWith(REQUIREMENTS_BLOCK_HEADING);
  if (!isCue && !hasIds) return null;
  const stripped = withoutSendBackRef(message.body);
  if (!hasIds) return { summary: null, body: "", lead: stripped };
  const { ids, rest } = splitIdsBlock(stripped);
  return { summary: "The requirement ids, as minted", body: ids, lead: rest || null };
}

/** Mail the app sends a specialist on its own account names itself in its
 *  subject: the chat shows it, and the reply `pairReplies` pairs with it, as
 *  one event line, without reading either body. */
const APP_SUBJECT = "[app:";
/** On the project owner's package request, so its line says "your" from the role, not their name. */
const OWNER_TAG = "[role:project_owner]";
type AppLine = (about: string, tags: readonly string[]) => string;
const APP_LINES = new Map<string, readonly [AppLine, AppLine | null]>([
  [
    "package",
    [
      (audience, tags) => (tags.includes(OWNER_TAG) ? "Asked for your package" : `Asked for the package for ${audience}`),
      (audience, tags) => (tags.includes(OWNER_TAG) ? "Answered the request for your package" : `Answered the package request for ${audience}`),
    ],
  ],
  ["brief", [(attempt) => `Recorded attempt ${attempt} for the build supervisor`, null]],
  ["choice", [(approach) => `You chose ${approach}`, null]],
]);

type AppKind = "package" | "brief" | "choice";

/** `about` comes last, after any other tags, so it is read back whole. */
export function appSubject(kind: AppKind, about: string, tags: readonly string[] = []): string {
  return `${APP_SUBJECT}${kind}] ${[...tags, about].join(" ")}`;
}

/** The subject of a request for an audience's package. */
export function packageSubject(audience: PackageAudience): string {
  return appSubject("package", audience.name, isOwner(audience) ? [OWNER_TAG] : []);
}

/** What a person-side app subject names, by kind; null for any other message. */
function appSubjectOf(
  message: Pick<ChatMessage, "author" | "subject"> | undefined,
): { readonly kind: string; readonly about: string; readonly tags: readonly string[] } | null {
  const subject = message?.author === "me" ? (message.subject ?? "") : "";
  if (!subject.startsWith(APP_SUBJECT)) return null;
  const aboutAt = subject.lastIndexOf("] ") + 2;
  return {
    kind: subject.slice(APP_SUBJECT.length, subject.indexOf("]")),
    about: subject.slice(aboutAt),
    tags: subject.slice(subject.indexOf("] ") + 2, aboutAt).split(" "),
  };
}

/** The audience a package request names, or null. */
export function packageAudienceOf(message: Pick<ChatMessage, "author" | "subject">): string | null {
  const app = appSubjectOf(message);
  return app?.kind === "package" ? app.about : null;
}

/** The stage 3 approach a message chose, or null. */
export function chosenApproach(message: Pick<ChatMessage, "author" | "subject">): string | null {
  const app = appSubjectOf(message);
  return app?.kind === "choice" ? app.about : null;
}

/** The line a message shows as instead of a bubble, or null. Only a
 *  person-side subject is read: nothing a specialist writes becomes one. */
export function appEventLine(message: Pick<ChatMessage, "author" | "subject">, answers: Pick<ChatMessage, "author" | "subject"> | undefined): string | null {
  const app = appSubjectOf(message.author === "me" ? message : answers);
  const lines = app ? APP_LINES.get(app.kind) : undefined;
  if (!app || !lines) return null;
  const [sent, answer] = lines;
  return message.author === "me" ? sent(app.about, app.tags) : (answer?.(app.about, app.tags) ?? null);
}
