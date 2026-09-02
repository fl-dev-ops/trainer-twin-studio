import { prepareMarkdown } from "../../web/lib/chunking";

/** Use the same page/topic-aware preparation as application ingestion. */
export function chunkWithHeadingContext(markdown: string, targetChars = 2000): string[] {
  return prepareMarkdown(markdown, undefined, targetChars).chunks.map((chunk) => chunk.text);
}
