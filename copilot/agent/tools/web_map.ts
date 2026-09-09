import { defineTool } from "eve/tools";
import { z } from "zod";

const apiKey = process.env.FIRECRAWL_API_KEY;

export default defineTool({
  description: "Discover URLs on a site via Firecrawl map. Use before scraping to find relevant pages.",
  inputSchema: z.object({
    url: z.string().url(),
    limit: z.number().int().min(1).max(100).default(20),
    includeSubdomains: z.boolean().default(false),
  }),
  async execute({ url, limit = 20, includeSubdomains = false }) {
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
    const res = await fetch("https://api.firecrawl.dev/v1/map", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ url, limit, includeSubdomains }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Firecrawl map failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { success: boolean; links?: string[]; data?: { links?: string[] } | string[] };
    if (!data.success) throw new Error("Firecrawl returned success=false");
    const links = data.links ?? (Array.isArray(data.data) ? data.data : data.data?.links) ?? [];
    return { links };
  },
});
