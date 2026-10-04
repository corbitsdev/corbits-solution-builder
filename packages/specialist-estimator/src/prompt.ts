import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { estimator } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${estimator.system}\n\n${skillTextFor(estimator)}`;
