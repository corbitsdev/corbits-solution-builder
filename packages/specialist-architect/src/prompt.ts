import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { architect } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${architect.system}\n\n${skillTextFor(architect)}`;
