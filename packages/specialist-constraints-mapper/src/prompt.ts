import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { constraintsMapper } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${constraintsMapper.system}\n\n${skillTextFor(constraintsMapper)}`;
