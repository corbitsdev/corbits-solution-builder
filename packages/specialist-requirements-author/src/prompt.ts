import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { requirementsAuthor } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${requirementsAuthor.system}\n\n${skillTextFor(requirementsAuthor)}`;
