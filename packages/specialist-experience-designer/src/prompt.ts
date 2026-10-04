import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { experienceDesigner } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${experienceDesigner.system}\n\n${skillTextFor(experienceDesigner)}`;
