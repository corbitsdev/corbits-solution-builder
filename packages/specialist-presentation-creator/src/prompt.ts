import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { presentationCreator } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${presentationCreator.system}\n\n${skillTextFor(presentationCreator)}`;
