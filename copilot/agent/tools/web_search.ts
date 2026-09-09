import { defineTool } from "eve/tools";
import { z } from "zod";

const apiKey = process.env.FIRECRAWL_API_KEY;

export default defineTool({
  description: "Web search via Firecrawl. Use for current info, competitors, pricing, or anything not in Studio knowledge.",
  inputSchema: z.object({
    query: z.string().trim().min(2).max(200),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  async execute({ query, limit = 5 }) {
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, limit, scrapeOptions: { formats: ["markdown"] } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Firecrawl search failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { success: boolean; data: Array<{ title: string; url: string; description?: string; markdown?: string }> };
    if (!data.success) throw new Error("Firecrawl returned success=false");
    return data.data ?? [];
  },
});
