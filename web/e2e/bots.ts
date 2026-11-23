import type { APIRequestContext, Page } from "@playwright/test";
import { e2eUrl } from "./env";

const trpc = (path: string) => e2eUrl("dash", `/api/twin/${path}`);

/** The org's E2E bot (made through the API, on the trainer's own persona, when missing): its slug. */
export async function e2eBot(request: APIRequestContext) {
  const listed = await request.get(trpc(`bots.list?input=${encodeURIComponent(JSON.stringify({ json: null }))}`));
  const { bots, personas } = (await listed.json()).result.data.json as { bots: { slug: string; name: string }[]; personas: { id: string; own: boolean }[] };
  let slug = bots.find((bot) => bot.name === "E2E website bot")?.slug;
  if (!slug) {
    const created = await request.post(trpc("bots.create"), {
      data: { json: { personaId: (personas.find((persona) => persona.own) ?? personas[0]).id, name: "E2E website bot", objective: "Answer visitors' questions." } },
    });
    slug = (await created.json()).result.data.json.slug as string;
  }
  return slug;
}

/** The E2E bot's page. */
export async function openTwinBot(page: Page) {
  const slug = await e2eBot(page.request);
  await page.goto(e2eUrl("dash", `/bots/${encodeURIComponent(slug)}`));
  return slug;
}

/** The E2E bot as the bots API returns it (its widget id is the embed id). */
export async function e2eBotView(request: APIRequestContext) {
  const slug = await e2eBot(request);
  const response = await request.get(trpc(`bots.get?input=${encodeURIComponent(JSON.stringify({ json: { slug } }))}`));
  return (await response.json()).result.data.json as {
    slug: string; publicAccess: { enabled: boolean; maxSeconds: number };
    widget: { id: string; config: { allowedOrigins: string[]; welcome: string; accentColor: string } };
  };
}

/** Changes the E2E bot (bots.update). */
export async function updateE2eBot(request: APIRequestContext, changes: Record<string, unknown>) {
  const slug = await e2eBot(request);
  const response = await request.post(trpc("bots.update?batch=1"), {
    headers: { Origin: new URL(e2eUrl("dash")).origin },
    data: { "0": { json: { slug, ...changes } } },
  });
  if (!response.ok()) throw new Error(await response.text());
}
