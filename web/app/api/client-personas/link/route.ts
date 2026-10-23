import { NextResponse } from "next/server";
import { z } from "zod";
import { scrape } from "@/lib/firecrawl";
import { getTrainerOrg } from "@/lib/org";
import { OrganizationKnowledgeService } from "@/lib/org-knowledge";

const bodySchema = z.object({ url: z.string().trim().url().max(2048) }).strict();

/** Fetches a web page and adds it to the org's knowledge as a document a persona can draw on. */
export async function POST(request: Request) {
  const org = await getTrainerOrg();
  if (!org) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Paste a full link, starting with https://" }, { status: 400 });

  const url = new URL(parsed.data.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return NextResponse.json({ error: "Paste a web link" }, { status: 400 });
  }

  try {
    const page = await scrape({ url: url.toString(), formats: ["markdown"], onlyMainContent: true });
    const markdown = page.markdown?.trim();
    if (!markdown) return NextResponse.json({ error: "Could not read any text from that page" }, { status: 422 });
    const title = typeof page.metadata?.title === "string" && page.metadata.title.trim()
      ? page.metadata.title.trim()
      : `${url.hostname}${url.pathname}`;
    const fileName = `${title.replace(/[^a-zA-Z0-9._ -]+/g, " ").trim().slice(0, 80) || url.hostname}.md`;
    const file = new File([`# ${title}\n\nSource: ${url.toString()}\n\n${markdown}`], fileName, { type: "text/markdown" });
    const doc = await OrganizationKnowledgeService.uploadDocument(org.id, file);
    return NextResponse.json({ document: { id: doc.id, title, status: doc.status, sourceUrl: url.toString() } }, { status: 201 });
  } catch (error) {
    console.error("Persona link import failed", error);
    return NextResponse.json({ error: "Could not add that link. Check it opens in a browser and try again." }, { status: 502 });
  }
}
