/**
 * The base instructions (prompts/base-instructions.md) are written for interview sessions: about
 * 7,400 words, mostly workspace, turn-flow and session_plan rules. Playbook and twin sessions bring
 * their own flow, so they get only the sections below, verbatim. Interview sessions get the whole
 * file, framed the way eve framed it as static instructions.
 */

/** eve's header for a single static instructions file named "instructions". */
export const BASE_INSTRUCTIONS_HEADER = "Instructions (instructions)\n";

/** Sections every session needs, by exact heading; each runs to the next heading of any level. */
export const CORE_HEADINGS = [
  "## Authority and Evidence",
  "## 1. Operating Mode & Voice Rules (Highest Priority)",
  "### Audio & Spoken-First Rules (Mandatory in Voice Mode)",
  "### Visual & Screen Perception Constraints",
  "## 2. Identity & Name Lock Rules",
  "### SAME-TURN CONTINUATION (multiple spoken messages in one turn)",
];

/** The core sections in file order, or null if any heading is missing (then callers use the full file). */
export function coreInstructions(full: string): string | null {
  const lines = full.split("\n");
  const sections: string[] = [];
  for (const heading of CORE_HEADINGS) {
    const start = lines.indexOf(heading);
    if (start < 0) return null;
    let end = lines.findIndex((line, i) => i > start && /^#{1,6} /.test(line));
    if (end < 0) end = lines.length;
    // Drop the "---" rules and blank lines that separate a section from the next one.
    const body = lines.slice(start, end);
    while (body.length > 1 && /^(---)?\s*$/.test(body[body.length - 1])) body.pop();
    sections.push(body.join("\n"));
  }
  return sections.join("\n\n");
}

/** What a session gets as base instructions: the core for playbook/twin sessions, else the whole file. */
export function baseInstructions(full: string, lean: boolean): string {
  const body = (lean && coreInstructions(full)) || full.trim();
  return BASE_INSTRUCTIONS_HEADER + body;
}
