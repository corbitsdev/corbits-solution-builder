import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { brainstormer } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${brainstormer.system}\n\n${skillTextFor(brainstormer)}`;
