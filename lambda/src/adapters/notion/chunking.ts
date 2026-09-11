import { CHUNKING_VERSION, prepareMarkdown } from "../../chunking/markdown";
import { NotionCleaner } from "./cleaner";

/** Cleans Notion Markdown before applying the shared structural Markdown strategy. */
export function prepareNotionDocument(text: string, pageTitle?: string) {
  const sourceText = new NotionCleaner().clean(text);
  return { ...prepareMarkdown(sourceText, pageTitle), sourceText, chunkingVersion: CHUNKING_VERSION };
}
