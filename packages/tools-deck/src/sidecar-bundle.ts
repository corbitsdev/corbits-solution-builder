/**
 * Sidecar-bundle entry for `@solutions-builder/tools-deck` — the
 * convention-compliant tool factory the workflow's tool-package loader
 * invokes, following `@intx/tools-posix`'s `sidecar-bundle.ts` shape.
 *
 * Unlike the vendored `@intx/*` packages, this one ships as TypeScript
 * source rather than a `tsc` build: Bun evaluates `.ts` directly wherever
 * this package runs, in the workspace and in the deployed sidecar alike,
 * matching how `@solutions-builder/app` itself is consumed (no `dist/`).
 * The `intx-src` condition is kept only so this package's exports read the
 * same as the vendored convention elsewhere in the workspace.
 *
 * The tool renders a stakeholder's deck outline as PowerPoint bytes by
 * calling the deck authoring that already lives in `@solutions-builder/app/deck`
 * (`deckFrom`, `renderDeck`) — nothing here re-parses markdown or redraws a
 * slide. Illustrations stay out of its surface: drawing them needs a
 * connected image provider and a reader model to pick subjects, which is
 * genuinely host-side work (see `apps/hub/src/deck.ts`), so this renders
 * text-only slides, exactly what `renderDeck` produces for a `Deck` with no
 * `images` map.
 */
import { defineTool, type BaseEnv } from "@intx/agent";
import {
  DECK_MEDIA_TYPE,
  DECK_THEMES,
  DECK_TYPEFACES,
  DEFAULT_DECK_DESIGN,
  deckFileName,
  deckFrom,
  renderDeck,
  type DeckDesign,
  type TemplateTheme,
} from "@solutions-builder/app/deck";

/** The tool's name on the wire, and the id `check-ledger.ts` and the sidecar
 *  smoke look for on the deployed stage 5 agent's tool factories. */
export const TOOL_NAME = "render_deck";

/** The subset of `DeckDesign` the tool accepts: `images` and `template`
 *  need binary payloads (drawn illustrations, an uploaded style guide) this
 *  tool's plain-JSON surface does not carry, so a caller gets the default
 *  ("none" images, no template) for those. */
type ToolDesign = Pick<DeckDesign, "theme" | "typeface" | "density" | "notes" | "guidance">;

type RenderDeckArgs = {
  projectTitle: string;
  audience: string;
  role: string;
  markdown: string;
  design?: Partial<ToolDesign>;
  theme?: TemplateTheme;
};

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`render_deck: "${key}" must be a non-empty string`);
  }
  return value;
}

function parseDesign(value: unknown): Partial<ToolDesign> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error('render_deck: "design" must be an object');
  }
  const raw = value as Record<string, unknown>;
  const design: Partial<ToolDesign> = {};
  if (raw["theme"] !== undefined) {
    if (typeof raw["theme"] !== "string" || !(raw["theme"] in DECK_THEMES)) {
      throw new Error(`render_deck: "design.theme" must be one of ${Object.keys(DECK_THEMES).join(", ")}`);
    }
    design.theme = raw["theme"] as ToolDesign["theme"];
  }
  if (raw["typeface"] !== undefined) {
    if (typeof raw["typeface"] !== "string" || !(DECK_TYPEFACES as readonly string[]).includes(raw["typeface"])) {
      throw new Error(`render_deck: "design.typeface" must be one of ${DECK_TYPEFACES.join(", ")}`);
    }
    design.typeface = raw["typeface"] as ToolDesign["typeface"];
  }
  if (raw["density"] !== undefined) {
    if (raw["density"] !== "sparse" && raw["density"] !== "standard" && raw["density"] !== "full") {
      throw new Error('render_deck: "design.density" must be "sparse", "standard" or "full"');
    }
    design.density = raw["density"];
  }
  if (raw["notes"] !== undefined) {
    if (typeof raw["notes"] !== "boolean") throw new Error('render_deck: "design.notes" must be a boolean');
    design.notes = raw["notes"];
  }
  if (raw["guidance"] !== undefined) {
    if (typeof raw["guidance"] !== "string") throw new Error('render_deck: "design.guidance" must be a string');
    design.guidance = raw["guidance"];
  }
  return design;
}

function parseThemeString(raw: Record<string, unknown>, key: keyof TemplateTheme): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`render_deck: "theme.${key}" must be a string`);
  return value;
}

function parseTheme(value: unknown): TemplateTheme {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error('render_deck: "theme" must be an object');
  }
  const raw = value as Record<string, unknown>;
  const accent = parseThemeString(raw, "accent");
  const ink = parseThemeString(raw, "ink");
  const paper = parseThemeString(raw, "paper");
  const titleFace = parseThemeString(raw, "titleFace");
  const bodyFace = parseThemeString(raw, "bodyFace");
  const ratioRaw = raw["ratio"];
  if (ratioRaw !== undefined && typeof ratioRaw !== "number") {
    throw new Error('render_deck: "theme.ratio" must be a number');
  }
  return {
    ...(accent !== undefined ? { accent } : {}),
    ...(ink !== undefined ? { ink } : {}),
    ...(paper !== undefined ? { paper } : {}),
    ...(titleFace !== undefined ? { titleFace } : {}),
    ...(bodyFace !== undefined ? { bodyFace } : {}),
    ...(ratioRaw !== undefined ? { ratio: ratioRaw as number } : {}),
  };
}

function parseArgs(args: Record<string, unknown>): RenderDeckArgs {
  return {
    projectTitle: requireString(args, "projectTitle"),
    audience: requireString(args, "audience"),
    role: requireString(args, "role"),
    markdown: requireString(args, "markdown"),
    design: parseDesign(args["design"]),
    ...(args["theme"] !== undefined ? { theme: parseTheme(args["theme"]) } : {}),
  };
}

/** Renders the deck and returns it as a `data:` URI — the same inline
 *  encoding `apps/hub/src/deck.ts` stores a deck version's bytes as, so a
 *  caller that has seen a deck artifact before recognises the shape. Throws
 *  the real reason when there is nothing to render, never a placeholder. */
async function renderDeckContent(rawArgs: Record<string, unknown>): Promise<string> {
  const args = parseArgs(rawArgs);
  const design: DeckDesign = { ...DEFAULT_DECK_DESIGN, ...args.design };
  const built = deckFrom({
    projectTitle: args.projectTitle,
    audience: args.audience,
    role: args.role,
    markdown: args.markdown,
    design,
    ...(args.theme ? { theme: args.theme } : {}),
  });
  if (!built) {
    throw new Error(
      'render_deck: the markdown has no "### Deck outline" section with numbered items, so there is nothing to build slides from',
    );
  }
  const bytes = await renderDeck(built);
  const dataUri = `data:${DECK_MEDIA_TYPE};base64,${Buffer.from(bytes).toString("base64")}`;
  return JSON.stringify({ fileName: deckFileName(args.projectTitle, args.audience), mediaType: DECK_MEDIA_TYPE, dataUri });
}

/**
 * Named export the loader picks up. The id is package-namespaced per the
 * convention `@intx/agent`'s `defineTool` enforces.
 */
export const deck = defineTool<BaseEnv>({
  id: "@solutions-builder/tools-deck/render-deck",
  definitions: [{ name: TOOL_NAME }],
  factory: () => ({
    definitions: [
      {
        name: TOOL_NAME,
        description:
          'Render a stakeholder deck from a package\'s markdown: a "### Deck outline" section (numbered items become slides) and an optional "### Decision request" section (the closing slide). Returns a JSON object carrying the rendered PowerPoint as a data: URI. Fails when the markdown has no deck outline to build from — no images, look changes only through "design" and "theme".',
        inputSchema: {
          type: "object",
          properties: {
            projectTitle: { type: "string", description: "The project's title, shown on the cover slide" },
            audience: { type: "string", description: 'The stakeholder\'s name, e.g. "Barry Moneyman"' },
            role: { type: "string", description: 'The stakeholder\'s role, e.g. "budget approver"' },
            markdown: {
              type: "string",
              description: 'The package markdown carrying a "### Deck outline" section and, optionally, a "### Decision request" section',
            },
            design: {
              type: "object",
              description: "The look and content choices to render with; an unset field takes the default design.",
              properties: {
                theme: { type: "string", enum: Object.keys(DECK_THEMES) },
                typeface: { type: "string", enum: [...DECK_TYPEFACES] },
                density: { type: "string", enum: ["sparse", "standard", "full"] },
                notes: { type: "boolean", description: "Whether each slide carries the item's full text as speaker notes" },
                guidance: { type: "string", description: "What this deck should emphasise, in the person's words" },
              },
            },
            theme: {
              type: "object",
              description: "A style guide's look, overriding the design's theme colour and typefaces.",
              properties: {
                accent: { type: "string" },
                ink: { type: "string" },
                paper: { type: "string" },
                titleFace: { type: "string" },
                bodyFace: { type: "string" },
                ratio: { type: "number", description: "Width over height; 16:9 is 1.78, 4:3 is 1.33" },
              },
            },
          },
          required: ["projectTitle", "audience", "role", "markdown"],
        },
      },
    ],
    run: async (call, signal) => {
      try {
        signal.throwIfAborted();
        const content = await renderDeckContent(call.arguments);
        return { callId: call.id, content };
      } catch (err) {
        return { callId: call.id, content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  }),
});
