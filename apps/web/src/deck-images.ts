/**
 * Illustrations for a stakeholder's slides, drawn by a connected provider's
 * image model. Ported from `apps/hub`'s `deck-images.ts` (main) for the
 * browser: `findImageProvider` picks a connected provider that lists an
 * image model the same way main's `imageSource` does, reading the same
 * `Provider` listing Settings and the providers page already render.
 *
 * Main's `credentialFor` reads a provider's key from the hub's own secret
 * store, which the browser cannot do -- the hub never hands a sealed secret
 * back to the client (see `provider-catalog.ts`), and this build adds no new
 * route to change that. So generation here takes the provider's key as an
 * explicit argument, supplied by whoever calls it for one build; nothing is
 * stored. `findImageProvider` alone -- detection, no key -- is what Settings
 * uses to say plainly whether a picture path exists at all.
 */
import type { Provider } from "./client.js";

/** A cache key from a prompt, via the browser's own subtle-crypto digest. */
async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ImageCredential = { providerId: string; label: string; baseUrl: string; model: string; apiKey: string };

/** What an illustration should show, in the art director's words, by slide key ("cover" or an item's index). */
export type ArtDirection = Map<string, string>;

const IMAGE_MODELS = /^(gpt-image-[\w.-]+|dall-e-\d|[\w.-]*image[\w.-]*)$/i;
const IMAGE_RANK = ["gpt-image-1", "gpt-image-1-mini", "dall-e-3"];

function rank(model: string): number {
  const index = IMAGE_RANK.indexOf(model);
  return index === -1 ? IMAGE_RANK.length : index;
}

/**
 * The first connected, credentialed provider, in listed order, that carries
 * an image model -- detection only, no key. `null` when none does, which
 * Settings shows plainly rather than pretending the images control works.
 */
export function findImageProvider(providers: readonly Provider[]): { providerId: string; label: string; baseUrl: string; model: string } | null {
  for (const provider of providers) {
    if (provider.providerId === "anthropic" || provider.status !== "ready" || !provider.hasCredential || !provider.baseUrl) continue;
    const models = provider.models.filter((name) => IMAGE_MODELS.test(name)).sort((a, b) => rank(a) - rank(b));
    if (models.length === 0) continue;
    return { providerId: provider.providerId, label: provider.label, baseUrl: provider.baseUrl.replace(/\/+$/, ""), model: models[0]! };
  }
  return null;
}

const ART_DIRECTOR = [
  "You are the art director for a short business presentation. You read the whole deck and decide which slides an illustration would genuinely help, and what each picture should show so that it matches that slide's content.",
  "Answer with JSON only, no prose, in this shape:",
  '{"cover": {"illustrate": true, "subject": "..."}, "slides": [{"index": 0, "illustrate": true, "subject": "..."}, ...]}',
  "A subject is one or two sentences describing a concrete scene, object or metaphor drawn from the slide's own content, for an illustrator who has not read the deck. Name what is in the picture; do not name a style, colours, text or labels. Never ask for text, words, numbers, logos, charts with labels, or real people.",
  "Include every slide index in \"slides\" with illustrate true or false. Illustrate a slide only when a picture adds something a reader would not get from the words alone: a problem's setting, a process, a risk, a decision. Leave dense reference slides without one.",
].join("\n");

/** The house manner every picture is drawn in, after the art director's subject. */
export function houseStyle(colour: string): string {
  return `Flat vector editorial illustration, clean shapes, generous negative space, a restrained palette built around ${colour}, on a plain white background. No text, no words, no letters, no numbers, no logos. No real people's faces.`;
}

/** What the illustrator is asked for: the art director's subject, then the house manner, never any lettering. */
export function illustrationPrompt(args: { subject: string; colour: string }): string {
  return `${args.subject.trim().replace(/\s+/g, " ")} ${houseStyle(args.colour)}`;
}

type Plan = { cover?: { illustrate?: boolean; subject?: string }; slides?: { index: number; illustrate?: boolean; subject?: string }[] };

function parsePlan(answer: string): Plan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer)?.[1] ?? answer;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The model's answer about the deck's pictures was not a plan it could be read as.");
  return JSON.parse(fenced.slice(start, end + 1)) as Plan;
}

/** One chat completion, as its text. */
async function complete(credential: ImageCredential, system: string, user: string): Promise<string> {
  const response = await fetch(`${credential.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: credential.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], stream: false }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${credential.label} could not read the deck with ${credential.model} [HTTP ${response.status}].`);
  const parsed = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content ?? "";
}

/**
 * The art director's plan for the deck: which slides get a picture and what
 * each shows, from the credential's chat model. `mode` bounds it the way
 * main's does: "cover" asks about the cover alone, "all" takes a subject for
 * every slide, "some" lets the model choose.
 */
export async function artDirection(args: {
  credential: ImageCredential;
  mode: "cover" | "some" | "all";
  projectTitle: string;
  audience: string;
  role: string;
  guidance: string;
  slides: readonly { title: string; bullets: readonly string[]; notes: string }[];
  decision: readonly string[];
}): Promise<ArtDirection> {
  const content = JSON.stringify({
    title: args.projectTitle,
    preparedFor: `${args.audience}, ${args.role}`,
    ...(args.guidance.trim() ? { whatThisRoleCaresAbout: args.guidance.trim() } : {}),
    slides: args.slides.map((slide, index) => ({ index, title: slide.title, points: slide.bullets, notes: slide.notes.slice(0, 600) })),
    decisionRequest: args.decision,
  });
  const ask =
    args.mode === "cover"
      ? "Decide the cover's picture only; mark every slide illustrate false."
      : args.mode === "all"
        ? "Give the cover and every slide a subject; mark them all illustrate true."
        : "Choose which slides deserve a picture; a typical deck of this length has two to four, plus the cover.";
  const answer = await complete(args.credential, ART_DIRECTOR, `${ask}\n\nThe deck:\n${content}`);
  const plan = parsePlan(answer);
  const direction: ArtDirection = new Map();
  if (plan.cover?.illustrate && plan.cover.subject) direction.set("cover", plan.cover.subject);
  for (const slide of plan.slides ?? []) {
    if (!slide.illustrate || !slide.subject || !Number.isInteger(slide.index)) continue;
    if (slide.index < 0 || slide.index >= args.slides.length) continue;
    if (args.mode === "cover") continue;
    direction.set(String(slide.index), slide.subject);
  }
  if (args.mode === "all") {
    for (const [index, slide] of args.slides.entries()) {
      if (!direction.has(String(index))) direction.set(String(index), `${slide.title}. ${slide.bullets[0] ?? ""}`.trim());
    }
    if (!direction.has("cover")) direction.set("cover", `${args.projectTitle}. ${args.slides[0]?.bullets[0] ?? ""}`.trim());
  }
  return direction;
}

/** In-memory cache for the session: the browser has no filesystem to keep PNGs across runs, so a rebuild in the same tab reuses what it already drew. */
const imageCache = new Map<string, Promise<Uint8Array>>();

async function generate(credential: ImageCredential, prompt: string): Promise<Uint8Array> {
  const body: Record<string, unknown> = { model: credential.model, prompt, n: 1 };
  if (credential.model.startsWith("gpt-image")) {
    body.size = "1536x1024";
    body.quality = "medium";
  } else if (credential.model === "dall-e-3") {
    body.size = "1792x1024";
    body.response_format = "b64_json";
  } else {
    body.response_format = "b64_json";
  }
  const response = await fetch(`${credential.baseUrl}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${credential.label} could not draw the image with ${credential.model} [HTTP ${response.status}].`);
  const parsed = JSON.parse(text) as { data?: { b64_json?: string; url?: string }[] };
  const first = parsed.data?.[0];
  if (first?.b64_json) return Uint8Array.from(atob(first.b64_json), (char) => char.charCodeAt(0));
  if (first?.url) {
    const fetched = await fetch(first.url);
    if (!fetched.ok) throw new Error(`${credential.label} drew the image but it could not be fetched [HTTP ${fetched.status}].`);
    return new Uint8Array(await fetched.arrayBuffer());
  }
  throw new Error(`${credential.label} answered without an image.`);
}

/** One illustration, PNG bytes: from the session cache when the same thing was asked of the same model already. */
export async function illustration(credential: ImageCredential, prompt: string): Promise<Uint8Array> {
  const key = await contentHash(`${credential.model}\n${prompt}`);
  const cached = imageCache.get(key);
  if (cached) return cached;
  const promise = generate(credential, prompt);
  imageCache.set(key, promise);
  try {
    return await promise;
  } catch (cause) {
    imageCache.delete(key);
    throw cause;
  }
}
