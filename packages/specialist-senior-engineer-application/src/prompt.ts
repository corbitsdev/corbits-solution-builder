import { skillTextFor } from "@solutions-builder/specialist-shared/skill-text";
import { seniorEngineerApplication } from "./index.ts";

/** System prompt: the role's text plus the skills it carries. */
export const systemPrompt = `${seniorEngineerApplication.system}\n\n${skillTextFor(seniorEngineerApplication)}`;
