import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { proposer } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${proposer.system}\n\n${skillTextFor(proposer)}`;
