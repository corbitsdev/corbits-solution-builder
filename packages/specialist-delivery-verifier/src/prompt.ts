import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { deliveryVerifier } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${deliveryVerifier.system}\n\n${skillTextFor(deliveryVerifier)}`;
