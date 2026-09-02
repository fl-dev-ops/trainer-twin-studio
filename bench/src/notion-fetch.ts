// Step 1: freeze the Vasanth cohort Notion page (+ child pages) into a fixture
// so every benchmark run chunks byte-identical input.
//
// Fetching, retries, and Markdown retrieval reuse web/lib/notion.ts — the exact
// production code path — and sanitization mirrors web/lib/notion-ingestion.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./env";
import {
  getNotionMarkdown,
  getNotionPage,
  listNotionChildPageIds,
  parseNotionPageId,
} from "../../web/lib/notion";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "../fixtures");
const fixturePagesDir = join(fixtureDir, "pages");
const pageUrl = process.env.BENCH_NOTION_URL
  ?? "https://app.notion.com/p/CareerwithVasanth-Frontend-development-mastery-cohort-1-2f21199ccfe38090a0b5daf57d7d917c";

/** Mirrors sanitizeNotionMarkdown in web/lib/notion-ingestion.ts (not importable: it pulls in the DB). */
function sanitizeNotionMarkdown(markdown: string): string {
  return markdown
    .replace(/<page\s[^>]*>[\s\S]*?<\/page>/gi, "")
    .replace(/<empty-block\s*\/?>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function main() {
  const token = process.env.NOTION_API_TOKEN?.trim();
  if (!token) throw new Error("NOTION_API_TOKEN is not set (check web/.env)");
  const rootPageId = parseNotionPageId(pageUrl);

  // Depth-first traversal identical to the ingestion worker: children first in reading order.
  const stack: { pageId: string; parentPageId: string | null; titlePrefix: string }[] = [
    { pageId: rootPageId, parentPageId: null, titlePrefix: "" },
  ];
  const discovered = new Set([rootPageId]);
  const sections: { id: string; title: string; depth: number; markdown: string }[] = [];
  const manifest: { fetchedAt: string; sourceUrl: string; pages: { id: string; title: string; chars: number }[] } = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: pageUrl,
    pages: [],
  };

  while (stack.length > 0) {
    const current = stack.pop()!;
    const page = await getNotionPage(current.pageId, token);
    for (const childPageId of (await listNotionChildPageIds(page.id, token)).reverse()) {
      if (discovered.has(childPageId)) continue;
      discovered.add(childPageId);
      stack.push({ pageId: childPageId, parentPageId: page.id, titlePrefix: current.titlePrefix });
    }
    const content = sanitizeNotionMarkdown(await getNotionMarkdown(page.id, token));
    if (!content) continue;
    sections.push({ id: page.id, title: page.title, depth: 0, markdown: content });
    manifest.pages.push({ id: page.id, title: page.title, chars: content.length });
    console.info(`fetched "${page.title}" (${content.length} chars, ${discovered.size - 1 + sections.length}/${discovered.size} pages)`);
  }

  if (sections.length === 0) throw new Error("No accessible content on the page");

  // Same title-prefixing trick as storeAndIndexPage: `# <title>` leads each section.
  const body = sections
    .map((s) => `# ${s.title}\n\n${s.markdown}`)
    .join("\n\n");
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(fixturePagesDir, { recursive: true });
  for (const section of sections) {
    writeFileSync(
      join(fixturePagesDir, `${section.id}.md`),
      `# ${section.title}\n\n${section.markdown}\n`,
      "utf8",
    );
  }
  writeFileSync(join(fixtureDir, "page.md"), `${body}\n`, "utf8");
  writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.info(`fixture written: fixtures/page.md (${body.length} chars across ${sections.length} page(s))`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
