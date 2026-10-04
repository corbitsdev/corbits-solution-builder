import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { productGuide } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${productGuide.system}\n\n${skillTextFor(productGuide)}`;
