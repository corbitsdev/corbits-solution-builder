/**
 * The deck illustrator's prompts.
 *
 * What the art director model is told about a deck, and what an image model
 * is told to draw once a subject is chosen. Pure text construction and
 * answer parsing — no provider call, no credential, no cache — those stay in
 * the host (`apps/hub`'s `deck-images.ts`), which builds the pieces below
 * and only renders and reads them.
 */

/** What an illustration should show, in the art director's words, by slide key ("cover" or an item's index). */
export type ArtDirection = Map<string, string>;

export type ArtDirectionSlide = { title: string; bullets: readonly string[]; notes: string };

const ART_DIRECTOR = [
  "You are the art director for a short business presentation. You read the whole deck and decide which slides an illustration would genuinely help, and what each picture should show so that it matches that slide's content.",
  "Answer with JSON only, no prose, in this shape:",
  '{"cover": {"illustrate": true, "subject": "..."}, "slides": [{"index": 0, "illustrate": true, "subject": "..."}, ...]}',
  "A subject is one or two sentences describing a concrete scene, object or metaphor drawn from the slide's own content, for an illustrator who has not read the deck. Name what is in the picture; do not name a style, colours, text or labels. Never ask for text, words, numbers, logos, charts with labels, or real people.",
  "Include every slide index in \"slides\" with illustrate true or false. Illustrate a slide only when a picture adds something a reader would not get from the words alone: a problem's setting, a process, a risk, a decision. Leave dense reference slides without one.",
].join("\n");

/** The art director's system prompt, unchanged across every call. */
export function artDirectorSystemPrompt(): string {
  return ART_DIRECTOR;
}

/** The deck, as the art director reads it: title, audience, and every slide's content. */
export function artDirectionContent(args: {
  projectTitle: string;
  audience: string;
  role: string;
  guidance: string;
  slides: readonly ArtDirectionSlide[];
  decision: readonly string[];
}): string {
  return JSON.stringify({
    title: args.projectTitle,
    preparedFor: `${args.audience}, ${args.role}`,
    ...(args.guidance.trim() ? { whatThisRoleCaresAbout: args.guidance.trim() } : {}),
    slides: args.slides.map((slide, index) => ({ index, title: slide.title, points: slide.bullets, notes: slide.notes.slice(0, 600) })),
    decisionRequest: args.decision,
  });
}

/**
 * The user prompt for the art director: `mode` bounds it: "cover" asks about
 * the cover alone; "some" lets the model choose; "all" takes a subject for
 * every slide.
 */
export function artDirectionUserPrompt(mode: "cover" | "some" | "all", content: string): string {
  const ask =
    mode === "cover"
      ? "Decide the cover's picture only; mark every slide illustrate false."
      : mode === "all"
        ? "Give the cover and every slide a subject; mark them all illustrate true."
        : "Choose which slides deserve a picture; a typical deck of this length has two to four, plus the cover.";
  return `${ask}\n\nThe deck:\n${content}`;
}

export type Plan = { cover?: { illustrate?: boolean; subject?: string }; slides?: { index: number; illustrate?: boolean; subject?: string }[] };

/** The plan out of the model's answer, fences and prose around it tolerated. Returns null for anything that is not a genuine plan, rather than guessed at. */
export function parsePlan(answer: string): Plan | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer)?.[1] ?? answer;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1)) as Plan;
  } catch {
    return null;
  }
}

/**
 * The art director's plan, turned into an `ArtDirection`: validated against
 * the deck's own slide count, and — in "all" mode — filled in for whatever
 * the model left out, with a slide's own title and first point standing in.
 */
export function planToArtDirection(args: {
  plan: Plan;
  mode: "cover" | "some" | "all";
  projectTitle: string;
  slides: readonly ArtDirectionSlide[];
}): ArtDirection {
  const direction: ArtDirection = new Map();
  if (args.plan.cover?.illustrate && args.plan.cover.subject) direction.set("cover", args.plan.cover.subject);
  for (const slide of args.plan.slides ?? []) {
    if (!slide.illustrate || !slide.subject || !Number.isInteger(slide.index)) continue;
    if (slide.index < 0 || slide.index >= args.slides.length) continue;
    if (args.mode === "cover") continue;
    direction.set(String(slide.index), slide.subject);
  }
  if (args.mode === "all") {
    // Every slide, whatever the model left out: its title and first point stand in.
    for (const [index, slide] of args.slides.entries()) {
      if (!direction.has(String(index))) direction.set(String(index), `${slide.title}. ${slide.bullets[0] ?? ""}`.trim());
    }
    if (!direction.has("cover")) direction.set("cover", `${args.projectTitle}. ${args.slides[0]?.bullets[0] ?? ""}`.trim());
  }
  return direction;
}

/** The house manner every picture is drawn in, after the art director's subject. */
export function houseStyle(colour: string): string {
  return `Flat vector editorial illustration, clean shapes, generous negative space, a restrained palette built around ${colour}, on a plain white background. No text, no words, no letters, no numbers, no logos. No real people's faces.`;
}

/** What the illustrator is asked for: the art director's subject, then the house manner, never any lettering. */
export function illustrationPrompt(args: { subject: string; colour: string }): string {
  return `${args.subject.trim().replace(/\s+/g, " ")} ${houseStyle(args.colour)}`;
}
