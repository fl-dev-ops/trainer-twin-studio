import { z } from "zod";

/** Extracts a stable Notion page ID from a page URL, UUID, or compact 32-character ID. */
export function parseNotionPageId(value: string): string {
  const decoded = decodeURIComponent(value.trim());
  const matches = decoded.match(
    /[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
  );
  const raw = matches?.at(-1)?.replaceAll("-", "").toLowerCase();
  if (!raw || raw.length !== 32) throw new Error("Expected a Notion page URL or page ID");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

const publicNotionUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port && (
    url.hostname === "notion.so" || url.hostname.endsWith(".notion.so") ||
    url.hostname === "notion.site" || url.hostname.endsWith(".notion.site") ||
    url.hostname === "app.notion.com"
  );
}, "Expected a public HTTPS Notion page URL");

/** OAuth remains the default for existing callers; public imports never accept a connection. */
export const notionImportSchema = z.union([
  z.object({ mode: z.literal("oauth").default("oauth"), url: z.string().trim().min(1), connectionId: z.string().trim().min(1) }).strict(),
  z.object({ mode: z.literal("public"), url: publicNotionUrl }).strict(),
]);

export type NotionImportInput = z.infer<typeof notionImportSchema>;
