// Freeze a published Notion page and its public child pages without an API token.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./env";
import { parseNotionPageId } from "../../web/lib/notion";
import { getPublicNotionPage } from "../../ingestion-pipeline/src/adapters/notion/public-acquisition";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "../fixtures");
const fixturePagesDir = join(fixtureDir, "pages");
const pageUrl = process.env.BENCH_NOTION_URL
  ?? "https://app.notion.com/p/CareerwithVasanth-Frontend-development-mastery-cohort-1-2f21199ccfe38090a0b5daf57d7d917c";

async function main() {
  const rootPageId = parseNotionPageId(pageUrl);
  const queue = [rootPageId];
  const discovered = new Set(queue);
  const sections: { id: string; title: string; chars: number; markdown: string }[] = [];
  while (queue.length > 0) {
    const pageId = queue.shift()!;
    const rendered = await getPublicNotionPage(pageId);
    for (const child of rendered.children) {
      if (discovered.has(child)) continue;
      discovered.add(child);
      queue.push(child);
    }
    const markdown = `# ${rendered.page.title}\n\n${rendered.markdown}`.trim();
    sections.push({ id: pageId, title: rendered.page.title, chars: markdown.length, markdown });
    console.info(`frozen "${rendered.page.title}" (${sections.length}/${discovered.size} pages)`);
  }
  const combined = sections.map((section) => section.markdown).join("\n\n").trim() + "\n";
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(fixturePagesDir, { recursive: true });
  for (const section of sections) {
    writeFileSync(join(fixturePagesDir, `${section.id}.md`), `${section.markdown}\n`, "utf8");
  }
  writeFileSync(join(fixtureDir, "page.md"), combined, "utf8");
  writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify({
    fetchedAt: new Date().toISOString(), sourceUrl: pageUrl, rootPageId,
    pages: sections.map(({ markdown: _markdown, ...page }) => page),
  }, null, 2), "utf8");
  console.info(`fixture complete: ${sections.length} pages, ${combined.length} chars`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
