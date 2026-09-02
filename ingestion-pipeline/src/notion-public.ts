import { normalizeNotionId, NotionResponseError, type NotionPage } from "./notion";

type RichText = [string, unknown[]?][];
type Block = {
  id: string;
  type: string;
  content?: string[];
  properties?: Record<string, RichText>;
  format?: Record<string, unknown>;
  last_edited_time?: number;
};
type Chunk = {
  cursor?: { stack?: unknown[] };
  recordMap?: { block?: Record<string, { value?: { value?: Block } }> };
};

const BACKOFF_MS = [500, 2_000, 4_500];

/** Uses only Notion's public web endpoint; never sends OAuth tokens or session cookies. */
async function fetchChunk(pageId: string, cursor: { stack?: unknown[] }, chunkNumber: number): Promise<Chunk> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    console.info(`[EXT-API:notion-public] start pageId=${pageId} chunk=${chunkNumber} attempt=${attempt + 1}`);
    try {
      const response = await fetch("https://app.notion.com/api/v3/loadPageChunk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId, limit: 100, cursor, chunkNumber, verticalColumns: false }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (!response.ok) throw new NotionResponseError(response.status);
      const chunk = await response.json() as Chunk;
      console.info(`[EXT-API:notion-public] complete pageId=${pageId} chunk=${chunkNumber} attempt=${attempt + 1} elapsedMs=${Date.now() - startedAt}`);
      return chunk;
    } catch (error) {
      console.error(`[EXT-API:notion-public] failed pageId=${pageId} chunk=${chunkNumber} attempt=${attempt + 1} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`);
      if (attempt >= BACKOFF_MS.length || (error instanceof NotionResponseError && error.status !== 429 && error.status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
    }
  }
}

async function fetchBlocks(pageId: string): Promise<Map<string, Block>> {
  const blocks = new Map<string, Block>();
  let cursor: { stack?: unknown[] } = { stack: [] };
  let chunkNumber = 0;
  do {
    const payload = await fetchChunk(pageId, cursor, chunkNumber);
    for (const record of Object.values(payload.recordMap?.block ?? {})) {
      const block = record.value?.value;
      if (block?.id) blocks.set(block.id, block);
    }
    cursor = payload.cursor ?? { stack: [] };
    chunkNumber++;
    if (chunkNumber > 100) throw new Error(`Public Notion pagination exceeded 100 chunks for ${pageId}`);
  } while ((cursor.stack?.length ?? 0) > 0);
  if (!blocks.has(pageId)) throw new Error(`Notion page ${pageId} is unavailable or not public`);
  return blocks;
}

function richText(value?: RichText): string {
  return (value ?? []).map(([text, annotations]) => {
    if (text !== "‣" && text !== "⁍") return text;
    for (const annotation of annotations ?? []) {
      if (!Array.isArray(annotation) || annotation[0] !== "lm" || typeof annotation[1] !== "object" || !annotation[1]) continue;
      const link = annotation[1] as { href?: unknown; title?: unknown };
      if (typeof link.href === "string") return `[${typeof link.title === "string" ? link.title : link.href}](${link.href})`;
    }
    return "";
  }).join("").trim();
}

/** Keeps the benchmark's Markdown rendering and discovers child pages without fetching them. */
function renderPage(pageId: string, blocks: Map<string, Block>) {
  const children: string[] = [];
  const seen = new Set<string>();
  function render(id: string): string {
    if (seen.has(id)) return "";
    seen.add(id);
    const block = blocks.get(id);
    if (!block) return "";
    if (block.type === "page") {
      if (id !== pageId) children.push(normalizeNotionId(id));
      return "";
    }
    const text = richText(block.properties?.title);
    const nested = (block.content ?? []).map(render).filter(Boolean).join("\n\n");
    let own = text;
    if (block.type === "header") own = `## ${text}`;
    else if (block.type === "sub_header") own = `### ${text}`;
    else if (block.type === "sub_sub_header") own = `#### ${text}`;
    else if (block.type === "bulleted_list" || block.type === "toggle") own = text ? `- ${text}` : "";
    else if (block.type === "numbered_list") own = text ? `1. ${text}` : "";
    else if (block.type === "quote" || block.type === "callout") own = text ? `> ${text}` : "";
    else if (block.type === "divider") own = "---";
    else if (block.type === "code") own = text ? `\`\`\`${richText(block.properties?.language).toLowerCase()}\n${text}\n\`\`\`` : "";
    else if (["image", "video", "audio", "file", "pdf"].includes(block.type)) {
      const source = block.format?.display_source ?? block.format?.source;
      own = [richText(block.properties?.caption), typeof source === "string" ? source : ""].filter(Boolean).join(" — ");
    }
    return [own, nested].filter(Boolean).join("\n\n");
  }
  const root = blocks.get(pageId)!;
  const page: NotionPage = {
    id: pageId,
    title: richText(root.properties?.title) || `Notion page ${pageId.slice(0, 8)}`,
    lastEditedAt: root.last_edited_time ? new Date(root.last_edited_time) : new Date(),
  };
  return { page, markdown: (root.content ?? []).map(render).filter(Boolean).join("\n\n"), children: [...new Set(children)] };
}

/** Fetches exactly one public page; Lambda queues discovered children as separate SQS messages. */
export async function getPublicNotionPage(value: string) {
  const pageId = normalizeNotionId(value);
  return renderPage(pageId, await fetchBlocks(pageId));
}
