/** Preserve the existing Notion-specific cleanup before structural preparation. */
export function sanitizeNotionMarkdown(markdown: string): string {
  return markdown.replace(/<page\s[^>]*>[\s\S]*?<\/page>/gi, "").replace(/<empty-block\s*\/?>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

export class NotionCleaner {
  clean(rawText: string): string {
    return sanitizeNotionMarkdown(rawText);
  }
}
