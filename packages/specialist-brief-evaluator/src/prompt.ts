import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { briefEvaluator } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${briefEvaluator.system}\n\n${skillTextFor(briefEvaluator)}`;
