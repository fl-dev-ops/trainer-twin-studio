import { z } from "zod";

const apiKey = process.env.FIRECRAWL_API_KEY;

export const webSearchInput = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(10).default(5),
});

export type WebSearchInput = z.infer<typeof webSearchInput>;

export type WebSearchResult = {
  title: string;
  url: string;
  description?: string;
  markdown?: string;
};

export async function webSearch(input: WebSearchInput): Promise<WebSearchResult[]> {
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query: input.query, limit: input.limit, scrapeOptions: { formats: ["markdown"] } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Firecrawl search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { success: boolean; data?: WebSearchResult[] };
  if (!data.success) throw new Error("Firecrawl returned success=false");
  return data.data ?? [];
}

// Scrape
export const scrapeInput = z.object({
  url: z.string().url(),
  formats: z.array(z.enum(["markdown", "html", "json"])).default(["markdown"]),
  onlyMainContent: z.boolean().default(true),
});
export type ScrapeInput = z.infer<typeof scrapeInput>;
export type ScrapeResult = { markdown?: string; html?: string; json?: unknown; metadata?: Record<string, unknown> };

export async function scrape(input: ScrapeInput): Promise<ScrapeResult> {
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Firecrawl scrape failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { success: boolean; data?: ScrapeResult };
  if (!data.success) throw new Error("Firecrawl returned success=false");
  return data.data ?? {};
}

// Map (discover URLs)
export const mapInput = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(100).default(20),
  includeSubdomains: z.boolean().default(false),
});
export type MapInput = z.infer<typeof mapInput>;
export type MapResult = { links: string[] };

export async function map(input: MapInput): Promise<MapResult> {
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
  const res = await fetch("https://api.firecrawl.dev/v1/map", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Firecrawl map failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { success: boolean; links?: string[]; data?: { links?: string[] } | string[] };
  if (!data.success) throw new Error("Firecrawl returned success=false");
  const links = data.links ?? (Array.isArray(data.data) ? data.data : data.data?.links) ?? [];
  return { links };
}
