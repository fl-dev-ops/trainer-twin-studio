import { createDecipheriv } from "node:crypto";
import type { PipelineConfig } from "../../config";

const BACKOFF_MS = [500, 2_000, 4_500];

export class NotionResponseError extends Error {
  constructor(readonly status: number) {
    super(`Notion returned ${status}`);
  }
}

type RichText = { plain_text?: string };
type PageResponse = { id: string; last_edited_time: string; properties?: Record<string, { type?: string; title?: RichText[] }> };
type MarkdownResponse = { markdown: string; truncated: boolean; unknown_block_ids: string[] };
type Block = { id: string; type: string; has_children: boolean };
type BlockList = { results: Block[]; has_more: boolean; next_cursor: string | null };

export type NotionPage = { id: string; title: string; lastEditedAt: Date };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retryableStatus = (status: number) => status === 429 || status >= 500;

function logPath(path: string) {
  return path
    .replace(/[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, ":id")
    .replace(/start_cursor=[^&]+/i, "start_cursor=:cursor");
}

export function decryptNotionToken(payload: string, encodedKey: string): string {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("NOTION_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted Notion token");
  const [iv, authTag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Calls a Notion endpoint with 500/2000/4500ms retry delays for network, 429, and 5xx failures. */
async function request<T>(config: PipelineConfig, path: string, accessToken: string): Promise<T> {
  const endpoint = logPath(path);
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const startedAt = Date.now();
    console.info(`[EXT-API:notion] start path=${endpoint} attempt=${attempt + 1}`);
    try {
      const response = await fetch(`https://api.notion.com/v1${path}`, {
        headers: { Authorization: `Bearer ${accessToken}`, "Notion-Version": config.notionApiVersion },
        signal: AbortSignal.timeout(30_000),
      });
      console.info(`[EXT-API:notion] complete path=${endpoint} attempt=${attempt + 1} status=${response.status} elapsedMs=${Date.now() - startedAt}`);
      if (response.ok) return await response.json() as T;
      throw new NotionResponseError(response.status);
    } catch (error) {
      lastError = error;
      console.error(`[EXT-API:notion] failed path=${endpoint} attempt=${attempt + 1} elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof NotionResponseError && !retryableStatus(error.status)) throw error;
      if (attempt === BACKOFF_MS.length) throw error;
    }
    await sleep(BACKOFF_MS[attempt]);
  }
  throw lastError instanceof Error ? lastError : new Error("Notion request failed");
}

export function normalizeNotionId(value: string): string {
  const raw = value.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(raw)) throw new Error("Invalid Notion page ID");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export async function getNotionPage(config: PipelineConfig, pageId: string, token: string): Promise<NotionPage> {
  const page = await request<PageResponse>(config, `/pages/${pageId}`, token);
  const property = Object.values(page.properties ?? {}).find((item) => item.type === "title");
  const title = property?.title?.map((item) => item.plain_text ?? "").join("").trim();
  return { id: normalizeNotionId(page.id), title: title || `Notion page ${pageId.slice(0, 8)}`, lastEditedAt: new Date(page.last_edited_time) };
}

/** Fetches accessible Markdown; 404s for unknown permission-restricted subtrees are omitted. */
export async function getNotionMarkdown(config: PipelineConfig, pageId: string, token: string): Promise<string> {
  const seen = new Set<string>();
  async function read(id: string, optional = false): Promise<string> {
    if (seen.has(id)) return "";
    seen.add(id);
    try {
      const result = await request<MarkdownResponse>(config, `/pages/${id}/markdown`, token);
      if (result.truncated && result.unknown_block_ids.length === 0) throw new Error("Notion returned truncated Markdown without recoverable block IDs");
      const tails = await Promise.all(result.unknown_block_ids.map((unknown) => read(unknown, true)));
      return [result.markdown, ...tails].filter(Boolean).join("\n\n");
    } catch (error) {
      if (optional && error instanceof NotionResponseError && error.status === 404) return "";
      throw error;
    }
  }
  return read(pageId);
}

async function getBlockChildren(config: PipelineConfig, blockId: string, token: string): Promise<Block[]> {
  const blocks: Block[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = await request<BlockList>(config, `/blocks/${blockId}/children?${query}`, token);
    blocks.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return blocks;
}

export async function listNotionChildPageIds(config: PipelineConfig, pageId: string, token: string): Promise<string[]> {
  const pages = new Set<string>();
  const visited = new Set<string>();
  async function walk(id: string): Promise<void> {
    if (visited.has(id)) return;
    visited.add(id);
    for (const block of await getBlockChildren(config, id, token)) {
      if (block.type === "child_page") pages.add(normalizeNotionId(block.id));
      else if (block.has_children) await walk(block.id);
    }
  }
  await walk(pageId);
  return [...pages];
}

export { sanitizeNotionMarkdown } from "./cleaner";
