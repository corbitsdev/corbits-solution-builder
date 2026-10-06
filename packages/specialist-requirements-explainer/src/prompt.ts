import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { requirementsExplainer } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${requirementsExplainer.system}\n\n${skillTextFor(requirementsExplainer)}`;
