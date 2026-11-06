/**
 * The "I've attached a file" marker the call clients send when a learner or calibration attaches a file mid-call
 * (lib/upload-client.ts `attachedMessage`): the chat bridge turns it into a real file part for the agent, but saved
 * transcripts keep the raw text, which this parser splits back out.
 */

export type ParsedAttachment = { id: string; name: string };

/** `I've attached a file: <name> [ATTACHED <id>]` */
const attached = /\bI've attached a file: ([^[\]]*?)\s*\[ATTACHED ([A-Za-z0-9_-]{1,120})\]/g;

/** Strips the attachment markers out of a turn's text, returning the clean text and the files it referenced. */
export function stripAttachments(text: string): { text: string; files: ParsedAttachment[] } {
  const regex = new RegExp(attached, "g");
  const files = [...text.matchAll(regex)].map((match) => ({ id: match[2], name: match[1].trim() }));
  if (!files.length) return { text, files };
  return { text: text.replace(regex, "").replace(/\n{2,}/g, "\n").trim(), files };
}
