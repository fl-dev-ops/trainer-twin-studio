import { formatFromExtension, toMarkdownBytes } from "@firecrawl/anydoc";

/** Extensions AnyDoc can convert to Markdown. */
export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
  "xls", "xlsx", "xlsm", "xlsb", "odt", "ods", "odp", "rtf", "epub", "csv", "pdf",
] as const;

const PLAIN_EXTENSIONS = ["md", "txt"] as const;
export const ALL_DOCUMENT_EXTENSIONS = [...SUPPORTED_DOCUMENT_EXTENSIONS, ...PLAIN_EXTENSIONS] as const;

export async function documentToMarkdown(file: File, maxBytes = 25 * 1024 * 1024) {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const isPlain = (PLAIN_EXTENSIONS as readonly string[]).includes(ext);
  if (!isPlain && !SUPPORTED_DOCUMENT_EXTENSIONS.includes(ext as (typeof SUPPORTED_DOCUMENT_EXTENSIONS)[number])) {
    throw new Error(`Unsupported file type .${ext} — supported: ${ALL_DOCUMENT_EXTENSIONS.join(", ")}`);
  }
  if (file.size > maxBytes) throw new Error(`File larger than ${Math.floor(maxBytes / 1024 / 1024)} MB`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const markdown = (isPlain
    ? new TextDecoder().decode(bytes)
    : await toMarkdownBytes(bytes, formatFromExtension(ext))).trim();
  if (!markdown) throw new Error("No readable text could be extracted from this file");
  return { ext, bytes, markdown };
}
