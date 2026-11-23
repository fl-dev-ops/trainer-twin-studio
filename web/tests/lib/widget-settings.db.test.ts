import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { twinRouter } from "@/lib/twin/trpc";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

/** Bots and their public settings through the studio API (lib/bots, lib/twin/trpc botsRouter). */
describe.skipIf(!localMinutesDb)("bots and widget settings (real database)", () => {
  let f: MinutesFixture;
  let personaId: string;
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    personaId = (await db.persona.findFirstOrThrow({ where: { orgId: f.org.id, slug: f.org.slug }, select: { id: true } })).id;
  });
  afterEach(async () => {
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });
  const admin = () => twinRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const newBot = async (name = "Homepage") => (await admin().bots.create({ personaId, name, objective: "Welcome visitors." })).slug;

  test("widget settings merge, normalize, and turn on exactly with a website list", async () => {
    const slug = await newBot();
    const caller = admin();
    await caller.bots.update({ slug, widget: { allowedOrigins: ["https://EXAMPLE.com:443"], welcome: "Ask Alex", accentColor: "#AABBCC" } });
    const first = await caller.bots.get({ slug });
    expect(first.widget.config).toEqual({ enabled: true, allowedOrigins: ["https://example.com"], welcome: "Ask Alex", accentColor: "#aabbcc" });
    expect(first.publicAccess).toEqual({ enabled: false, maxSeconds: 300 });
    await caller.bots.update({ slug, publicAccess: { enabled: true } });
    expect((await caller.bots.get({ slug })).widget.config).toEqual(first.widget.config);
    await caller.bots.update({ slug, widget: { allowedOrigins: [] } });
    expect((await caller.bots.get({ slug })).widget.config).toMatchObject({ enabled: false, allowedOrigins: [] });
    await expect(caller.bots.update({ slug, widget: { enabled: true } } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.bots.update({ slug, widget: { allowedOrigins: ["https://*.example.com"] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const got = await caller.bots.get({ slug });
    expect(new URL(got.widget.origin).hostname.startsWith(`${f.org.slug}.`)).toBe(true);
  });

  test("an org runs several independent bots, each with its own persona, purpose, skills and websites; twins are untouched", async () => {
    const twinBefore = await db.agent.findUniqueOrThrow({ where: { id: f.twin.id } });
    const custom = await db.persona.create({ data: { orgId: f.org.id, slug: `${f.org.slug}-guide`, name: "Guide", data: {} } });
    const caller = admin();
    const home = await newBot("Homepage");
    const pricing = (await caller.bots.create({ personaId: custom.id, name: "Pricing", objective: "Answer pricing questions." })).slug;
    expect(home).not.toBe(pricing);
    await caller.bots.update({ slug: pricing, objective: "Explain plans and suggest a call.", publicAccess: { enabled: true }, widget: { allowedOrigins: ["https://pricing.example"] } });
    expect(await caller.bots.get({ slug: pricing })).toMatchObject({
      name: "Pricing", objective: "Explain plans and suggest a call.", persona: { id: custom.id }, skills: [],
      publicAccess: { enabled: true }, widget: { config: { allowedOrigins: ["https://pricing.example"] } },
    });
    expect((await caller.bots.get({ slug: home })).publicAccess.enabled).toBe(false);
    const listed = await caller.bots.list();
    expect(listed.bots.map((bot) => bot.name)).toEqual(["Homepage", "Pricing"]);
    expect(listed.personas.map((persona) => persona.id)).toEqual(expect.arrayContaining([personaId, custom.id]));
    // Switching a bot's persona is a bot edit; a repeated save changes nothing.
    await caller.bots.update({ slug: home, personaId: custom.id });
    expect((await caller.bots.get({ slug: home })).persona.id).toBe(custom.id);
    expect((await caller.bots.update({ slug: pricing, name: "Pricing" })).version).toBe(2);
    expect(await db.agent.findUniqueOrThrow({ where: { id: f.twin.id } })).toMatchObject({ version: twinBefore.version, data: twinBefore.data as object });
    await caller.bots.archive({ slug: home });
    expect((await caller.bots.list()).bots.map((bot) => bot.name)).toEqual(["Pricing"]);
    await expect(caller.bots.get({ slug: home })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("only studio members manage bots", async () => {
    const slug = await newBot();
    const learner = twinRouter.createCaller({ user: { ...f.learner, orgId: f.org.id, orgSlug: f.org.slug, role: "user" } });
    await expect(learner.bots.update({ slug, name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(twinRouter.createCaller({ user: null }).bots.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
