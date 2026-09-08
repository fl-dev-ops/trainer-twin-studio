// Freeze a published Notion page and its public child pages without an API token.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../shared/env";
import { parseNotionPageId } from "../../../web/lib/notion";
import { getPublicNotionPage } from "../../../ingestion-pipeline/src/adapters/notion/public-acquisition";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "../../fixtures");
const fixturePagesDir = join(fixtureDir, "pages");

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const pageUrl =
    argValue("--url") ??
    process.env.NOTION_PAGE_URL ??
    "https://app.notion.com/p/CareerwithVasanth-Frontend-development-mastery-cohort-1-2f21199ccfe38090a0b5daf57d7d917c";
  const rootPageId = parseNotionPageId(pageUrl);
  if (!rootPageId) {
    throw new Error(`could not parse a notion page id from ${pageUrl}`);
  }

  const { sections, combined } = await getPublicNotionPage(rootPageId);
  mkdirSync(fixturePagesDir, { recursive: true });
  for (const page of sections) {
    writeFileSync(join(fixturePagesDir, `${page.id}.md`), `${page.markdown}\n`, "utf8");
  }
  writeFileSync(join(fixtureDir, "page.md"), combined, "utf8");
  writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify({
    fetchedAt: new Date().toISOString(), sourceUrl: pageUrl, rootPageId,
    pages: sections.map(({ markdown: _markdown, ...page }) => page),
  }, null, 2), "utf8");
  console.info(`public fixture written: fixtures/page.md (${combined.length} chars across ${sections.length} page(s))`);
}

main().catch((error) => {
  console.error("public notion fetch failed:", error);
  process.exit(1);
});
