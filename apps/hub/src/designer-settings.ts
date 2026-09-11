/**
 * The designer's settings: the surface and design language it is asked for,
 * how many output tokens a design may use, and what happens when one uses
 * them all.
 *
 * A file beside the start-at-login marker rather than rows: these are one
 * person's preferences for one workspace, read once per draft, and the
 * builder schema deliberately carries no preference table any more. The
 * client reads and writes them through the host's preferences API under
 * `designer.*` keys; only the host touches the file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type } from "arktype";
import { HostError } from "./errors.js";
import { designerSettingsFile } from "./paths.js";

export const DESIGNER_TOKENS_MIN = 1_000;
export const DESIGNER_TOKENS_MAX = 64_000;
/**
 * A real design — every state shown, an id on every element, three note
 * sections — runs 20,000 to 40,000 tokens. 8,000 cut most of them short.
 */
export const DESIGNER_TOKENS_DEFAULT = 32_000;

const Settings = type({
  /** What the mockup is drawn on. `brief` leaves it to the document's brief. */
  surface: "'light' | 'dark' | 'brief'",
  /** The person's own design language: palette, type, tone, what to avoid. */
  language: "string",
  /** Output tokens a design may use. */
  maxTokens: `${DESIGNER_TOKENS_MIN} <= number.integer <= ${DESIGNER_TOKENS_MAX}`,
  /**
   * When a design uses every token it was allowed: `tell` stops and says so,
   * `raise` doubles the limit and tries once more, `reduce` tries once more
   * at lower resolution within the same limit.
   */
  onLimit: "'tell' | 'raise' | 'reduce'",
});

export type DesignerSettings = typeof Settings.infer;

export const DEFAULT_DESIGNER_SETTINGS: DesignerSettings = {
  surface: "light",
  language: "",
  maxTokens: DESIGNER_TOKENS_DEFAULT,
  onLimit: "tell",
};

/** The settings as saved, with defaults for anything missing or unreadable. */
export async function designerSettings(): Promise<DesignerSettings> {
  try {
    const raw = JSON.parse(await readFile(designerSettingsFile(), "utf8")) as unknown;
    const parsed = Settings({ ...DEFAULT_DESIGNER_SETTINGS, ...(raw as object) });
    return parsed instanceof type.errors ? DEFAULT_DESIGNER_SETTINGS : parsed;
  } catch {
    return DEFAULT_DESIGNER_SETTINGS;
  }
}

/** Saves a change to one or more settings, refusing a value the type rejects. */
export async function saveDesignerSettings(patch: Partial<DesignerSettings>): Promise<DesignerSettings> {
  const next = Settings({ ...(await designerSettings()), ...patch });
  if (next instanceof type.errors) {
    throw new HostError("validation_failed", `Designer settings: ${next.summary}`);
  }
  const file = designerSettingsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** What the settings add to the designer's instructions, every draft. */
export function designerGuidance(settings: DesignerSettings): string {
  const surface =
    settings.surface === "light"
      ? "A light surface: near-white page, dark text, colour reserved for meaning."
      : settings.surface === "dark"
        ? "A dark surface: near-black page, light text, colour reserved for meaning."
        : "The surface the brief calls for, light or dark; say which in the interaction notes.";
  const language = settings.language.trim();
  return [
    `Surface. ${surface}`,
    ...(language
      ? [
          "Design language, in the person's own words. It takes precedence over any default above and is to be followed, not interpreted away:",
          language,
        ]
      : []),
  ].join("\n\n");
}

/** Added to a retry after a design was cut short, under the `reduce` policy. */
/**
 * What a person is told when the retry the policy asked for was cut short as
 * well. Said in full: the policy fired, both attempts ran, both failed, and how
 * the second differed. A second failure worded like a first makes the policy
 * look as though it never ran.
 */
export function cutShortTwice(args: {
  title: string;
  onLimit: "raise" | "reduce";
  firstLimit: number;
  secondLimit: number;
}): string {
  const second =
    args.onLimit === "raise"
      ? `a second at the raised limit of ${args.secondLimit} tokens was cut short too`
      : "a second at lower resolution within the same limit was cut short too";
  const next = args.onLimit === "raise" ? "raise the limit further" : "raise the limit";
  return `${args.title} was cut short twice: the first attempt used every one of its ${args.firstLimit} tokens, and ${second}. Nothing was recorded. In Settings, Designer, you can ${next}.`;
}

export function lowerResolutionGuidance(limit: number): string {
  return [
    `Lower resolution. The previous attempt did not fit in ${limit} tokens and was cut short.`,
    "Produce the same document at lower resolution: the primary flow and the empty, loading, error and disabled states, each as a short section; terse CSS with no decoration and no repeated blocks; every `data-testid` and the three note sections kept, in fewer words.",
    `The whole document, tags included, must fit comfortably within ${limit} tokens; stop adding before it does.`,
  ].join("\n");
}
