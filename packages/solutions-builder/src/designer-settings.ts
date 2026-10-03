/**
 * The designer's settings: the surface and design language it is asked for.
 *
 * One person's preferences for one workspace tenant, held under
 * `DESIGNER_SETTINGS_CONFIG_KEY` in the tenant's own `config` -- the stock
 * per-tenant JSON every Interchange hub carries -- rather than a hub asset,
 * a builder-schema table or a host file. The client writes it through
 * `@solutions-builder/installer`. This module is the shared shape and
 * validation both sides use, and the text the stage-4 designer's role is
 * deployed with.
 */
import { type } from "arktype";

export const DESIGNER_SETTINGS_CONFIG_KEY = "sb.designerSettings";

const Settings = type({
  /** What the mockup is drawn on. `brief` leaves it to the document's brief. */
  surface: "'light' | 'dark' | 'brief'",
  /** The person's own design language: palette, type, tone, what to avoid. */
  language: "string",
});

export type DesignerSettings = typeof Settings.infer;

export const DEFAULT_DESIGNER_SETTINGS: DesignerSettings = {
  surface: "light",
  language: "",
};

/** Defaults filled in over whatever was read back, valid or not; never throws. */
export function parseDesignerSettings(raw: unknown): DesignerSettings {
  const parsed = Settings({ ...DEFAULT_DESIGNER_SETTINGS, ...(typeof raw === "object" && raw !== null ? raw : {}) });
  return parsed instanceof type.errors ? DEFAULT_DESIGNER_SETTINGS : parsed;
}

/** The result of merging a patch onto a base, refusing a value the type rejects. */
export function mergeDesignerSettings(
  base: DesignerSettings,
  patch: Partial<DesignerSettings>,
): DesignerSettings {
  const next = Settings({ ...base, ...patch });
  if (next instanceof type.errors) {
    throw new Error(`Designer settings: ${next.summary}`);
  }
  return next;
}

/** What the settings add to the experience designer's role at deploy. */
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
