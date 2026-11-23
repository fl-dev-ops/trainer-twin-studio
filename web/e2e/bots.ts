import type { Page } from "@playwright/test";
import { e2eUrl } from "./env";
import { seed } from "./seed-data";

const trpc = (path: string) => e2eUrl("dash", `/api/twin/${path}`);

/** The seeded twin's first bot (made through the API when it has none), opened on its Website bot page. */
export async function openTwinBot(page: Page) {
  const listed = await page.request.get(trpc(`bots.list?input=${encodeURIComponent(JSON.stringify({ json: null }))}`));
  const { bots } = (await listed.json()).result.data.json as { bots: { slug: string; twin: { slug: string } | null }[] };
  let slug = bots.find((bot) => bot.twin?.slug === seed().twin.slug)?.slug;
  if (!slug) {
    const created = await page.request.post(trpc("bots.create"), {
      data: { json: { twinSlug: seed().twin.slug, name: "E2E website bot", objective: "Answer visitors' questions." } },
    });
    slug = (await created.json()).result.data.json.slug as string;
  }
  await page.goto(e2eUrl("dash", `/bots/${encodeURIComponent(slug)}`));
  return slug;
}
