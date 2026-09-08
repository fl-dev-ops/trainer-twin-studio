// Freeze a published Notion page and its child pages through the official API.
//
// Requires NOTION_API_TOKEN. This reproduces the real customer-facing
// production code path — and sanitization mirrors web/lib/notion-ingestion.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../shared/env";
import {
  getNotionMarkdown,
  getNotionPage,
  listNotionChildPageIds,
  sanitizeNotionMarkdown,
} from "../../../ingestion-pipeline/src/adapters/notion/acquisition";
import { parseNotionPageId } from "../../../web/lib/notion";
import { loadConfig } from "../../../ingestion-pipeline/src/config";
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "../../fixtures");
const fixturePagesDir = join(fixtureDir, "pages");

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const token = process.env.NOTION_API_TOKEN;
  if (!token) {
    throw new Error("NOTION_API_TOKEN is not set — pass it in bench/.env or environment");
  }

  const pageUrl =
    argValue("--url") ??
    process.env.NOTION_PAGE_URL ??
    "https://app.notion.com/p/CareerwithVasanth-Frontend-development-mastery-cohort-1-2f21199ccfe38090a0b5daf57d7d917c";
  const rootPageId = parseNotionPageId(pageUrl);
  if (!rootPageId) {
    throw new Error(`could not parse a notion page id from ${pageUrl}`);
  }

  const manifest = {
    fetchedAt: new Date().toISOString(),
    sourceUrl: pageUrl,
    rootPageId,
    pages: [] as { id: string; title: string; chars: number }[],
  };

  const sections: { id: string; title: string; depth: number; markdown: string }[] = [];
  const discovered = new Set<string>([rootPageId]);
  const stack: { pageId: string; parentPageId: string | null; titlePrefix: string }[] = [
    { pageId: rootPageId, parentPageId: null, titlePrefix: "" },
  ];

  mkdirSync(fixturePagesDir, { recursive: true });

  while (stack.length > 0) {
    const current = stack.pop()!;
    const config = loadConfig();
    const page = await getNotionPage(config, current.pageId, token);
    for (const childPageId of (await listNotionChildPageIds(config, page.id, token)).reverse()) {
      if (discovered.has(childPageId)) continue;
      discovered.add(childPageId);
      stack.push({ pageId: childPageId, parentPageId: page.id, titlePrefix: current.titlePrefix });
    }
    const content = sanitizeNotionMarkdown(await getNotionMarkdown(config, page.id, token));
    if (!content) continue;
    sections.push({ id: page.id, title: page.title, depth: 0, markdown: content });
    manifest.pages.push({ id: page.id, title: page.title, chars: content.length });
    writeFileSync(join(fixturePagesDir, `${page.id}.md`), `${content}\n`, "utf8");
    console.info(`fetched ${page.title} (${content.length} chars)`);
  }

  const body = sections.map((s) => `# ${s.title}\n\n${s.markdown}`).join("\n\n---\n\n");
  writeFileSync(join(fixtureDir, "page.md"), `${body}\n`, "utf8");
  writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.info(`fixture written: fixtures/page.md (${body.length} chars across ${sections.length} page(s))`);
}

main().catch((error) => {
  console.error("notion fetch failed:", error);
  process.exit(1);
});
