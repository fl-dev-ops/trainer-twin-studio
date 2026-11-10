import BASE from "../../prompts/base-instructions.md?raw";
import PLATFORM from "../../prompts/platform.md?raw";
import SPEAKING_REMINDER from "../../prompts/speaking-reminder.md?raw";
import { formatSessionSpec, type SessionSpecs } from "./brain";
import { SPEAKING_MODEL } from "./models";
import { isTwinMode, sessionMode } from "./session-mode";

/**
 * A session's instructions, in layers:
 *   platform     prompts/platform.md: voice output, evidence, names, turn mechanics (every mode)
 *   mode         the mode's operating instructions (twin.md [+ twin-calibration.md], the client role play)
 *   capabilities the workspace surfaces switched on for the agent
 *   session data facts only
 * The mode block, capabilities and session data come from formatSessionSpec. Interview role plays (Vasanth's v1) are
 * frozen: the whole of prompts/base-instructions.md and the interview spec, exactly as before modes existed.
 */

/** eve's header for a single static instructions file named "instructions". */
export const INSTRUCTIONS_HEADER = "Instructions (instructions)\n";

/** Without a session to ground in (no org, or its context failed to load): the interview instructions, as always. */
export const FALLBACK_INSTRUCTIONS = INSTRUCTIONS_HEADER + BASE.trim();

export function composeInstructions(specs: SessionSpecs): string {
  const mode = sessionMode(specs);
  const base = mode === "roleplay-interview" ? BASE : PLATFORM;
  // A non-Google speaking model (models.ts) gets prompts/speaking-reminder.md last: it keeps to the fifty-word,
  // playbook-only, decline and closing rules less tightly than Gemini. Twin modes only; Gemini gets nothing extra.
  const reminder = isTwinMode(mode) && !SPEAKING_MODEL.startsWith("google/") ? `\n\n${SPEAKING_REMINDER.trim()}` : "";
  return `${INSTRUCTIONS_HEADER}${base.trim()}\n\n${formatSessionSpec(specs)}${reminder}`;
}
