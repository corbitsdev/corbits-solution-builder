import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { namer } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${namer.system}\n\n${skillTextFor(namer)}`;
