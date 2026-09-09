import { defineTool } from "eve/tools";
import { z } from "zod";

const apiKey = process.env.FIRECRAWL_API_KEY;

export default defineTool({
  description: "Scrape one URL to clean markdown via Firecrawl. Use after web_search when you need full page content.",
  inputSchema: z.object({
    url: z.string().url(),
    onlyMainContent: z.boolean().default(true),
  }),
  async execute({ url, onlyMainContent = true }) {
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Firecrawl scrape failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { success: boolean; data?: { markdown?: string; metadata?: Record<string, unknown> } };
    if (!data.success) throw new Error("Firecrawl returned success=false");
    return data.data ?? {};
  },
});
