import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateTwin } from "@/lib/twin/manage";
import { botForTwin, publicSettingsOf, widgetSettingsOf } from "@/lib/bots";
import { twinRouter } from "@/lib/twin/trpc";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("widget settings updates (real database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
  });
  afterEach(async () => {
    await db.specVersion.deleteMany({ where: { orgId: f.org.id } });
    await f.clean();
  });
  const twin = () => db.agent.findUniqueOrThrow({ where: { id: f.twin.id } });
  const bot = () => botForTwin(f.org.id, f.twin.id);
  const widget = async () => widgetSettingsOf((await bot())?.deployment ?? null);

  test("public settings live on the twin's bot: merged, normalized, and never version the twin", async () => {
    const before = await twin();
    await updateTwin(f.org.id, f.twin.slug, { widget: { allowedOrigins: ["https://EXAMPLE.com:443"], welcome: "Ask Alex", accentColor: "#AABBCC" } });
    const first = await widget();
    expect(first).toEqual({ enabled: true, allowedOrigins: ["https://example.com"], welcome: "Ask Alex", accentColor: "#aabbcc" });
    expect((await twin()).version).toBe(before.version);
    expect((await twin()).data).not.toHaveProperty("widget");
    expect(await bot()).toMatchObject({ personaId: before.personaId, data: { source: "bot", twinId: f.twin.id } });
    await updateTwin(f.org.id, f.twin.slug, { description: "Updated knowledge", publicAccess: { enabled: true } });
    expect(await widget()).toEqual(first);
    expect((await twin()).version).toBe(before.version + 1);
    expect(publicSettingsOf((await bot())!.deployment)).toEqual({ enabled: true, maxSeconds: 300 });
    const unchanged = await updateTwin(f.org.id, f.twin.slug, { widget: { welcome: "Ask Alex" } });
    expect(unchanged.changed).toBe(false);
    expect(await db.agent.count({ where: { orgId: f.org.id, kind: "BOT" } })).toBe(1);
  });

  test("the website list is the only switch: clearing it turns the widget off, an enabled flag cannot override it", async () => {
    await updateTwin(f.org.id, f.twin.slug, { widget: { allowedOrigins: ["https://example.com"] } });
    expect((await widget()).enabled).toBe(true);
    await updateTwin(f.org.id, f.twin.slug, { name: "Cleared list", widget: { allowedOrigins: [] } });
    expect(await twin()).toMatchObject({ name: "Cleared list" });
    expect(await widget()).toMatchObject({ enabled: false, allowedOrigins: [] });
    await updateTwin(f.org.id, f.twin.slug, { widget: { enabled: true } });
    expect((await widget()).enabled).toBe(false);
    await updateTwin(f.org.id, f.twin.slug, { widget: { enabled: false, allowedOrigins: ["https://example.com"] } });
    expect((await widget()).enabled).toBe(true);
  });

  test("does not enable public access as a side effect", async () => {
    await updateTwin(f.org.id, f.twin.slug, { widget: { allowedOrigins: ["https://example.com"] } });
    expect(publicSettingsOf((await bot())!.deployment).enabled).toBe(false);
    await updateTwin(f.org.id, f.twin.slug, { publicAccess: { enabled: false } });
    expect((await widget()).enabled).toBe(true);
  });

  test("enforces org scope and rejects malformed origins without saving", async () => {
    await expect(updateTwin("different-org", f.twin.slug, { widget: { allowedOrigins: ["https://example.com"] } })).rejects.toMatchObject({ code: "not_found" });
    const before = await twin();
    await expect(updateTwin(f.org.id, f.twin.slug, { widget: { allowedOrigins: ["https://*.example.com"] } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await twin()).version).toBe(before.version);
    expect(await bot()).toBeNull();
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("an org can run several bots per twin, each with its own name, purpose and websites; the twin is untouched", async () => {
    const user = { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" };
    const caller = twinRouter.createCaller({ user });
    const before = await twin();
    const home = await caller.bots.create({ twinSlug: f.twin.slug, name: "Homepage", objective: "Welcome visitors." });
    const pricing = await caller.bots.create({ twinSlug: f.twin.slug, name: "Pricing", objective: "Answer pricing questions." });
    expect(home.slug).not.toBe(pricing.slug);
    await caller.bots.update({ slug: pricing.slug, objective: "Explain plans and suggest a call.", publicAccess: { enabled: true }, widget: { allowedOrigins: ["https://pricing.example"] } });
    const got = await caller.bots.get({ slug: pricing.slug });
    expect(got).toMatchObject({ name: "Pricing", objective: "Explain plans and suggest a call.", twin: { slug: f.twin.slug }, publicAccess: { enabled: true }, widget: { config: { allowedOrigins: ["https://pricing.example"] } } });
    expect((await caller.bots.get({ slug: home.slug })).publicAccess.enabled).toBe(false);
    expect((await caller.bots.list()).bots.map((bot) => bot.name)).toEqual(["Homepage", "Pricing"]);
    expect((await caller.agents.get({ slug: f.twin.slug })).bots.map((bot) => bot.name)).toEqual(["Homepage", "Pricing"]);
    expect(await twin()).toMatchObject({ name: before.name, version: before.version, data: before.data as object });
    // Each bot versions on its own; a repeated save changes nothing.
    expect((await caller.bots.update({ slug: pricing.slug, name: "Pricing" })).version).toBe(2);
    await caller.bots.archive({ slug: home.slug });
    expect((await caller.bots.list()).bots.map((bot) => bot.name)).toEqual(["Pricing"]);
    await expect(caller.bots.get({ slug: home.slug })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(twinRouter.createCaller({ user: { ...user, ...f.learner, role: "user" } }).bots.update({ slug: pricing.slug, name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("studio API accepts partial updates and returns the stable ID and own-host origin", async () => {
    const user = { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" };
    const caller = twinRouter.createCaller({ user });
    await caller.agents.update({ slug: f.twin.slug, widget: { allowedOrigins: ["https://example.com"] } });
    await expect(caller.agents.update({ slug: f.twin.slug, widget: { enabled: false } } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const twin = await caller.agents.get({ slug: f.twin.slug });
    expect(twin.widget).toMatchObject({ id: (await bot())!.id, config: { enabled: true, allowedOrigins: ["https://example.com"] } });
    expect(new URL(twin.widget.origin).hostname.startsWith(`${f.org.slug}.`)).toBe(true);
    expect(twin.publicAccess.enabled).toBe(false);
    await caller.agents.update({ slug: f.twin.slug, widget: { allowedOrigins: [] } });
    expect((await caller.agents.get({ slug: f.twin.slug })).widget.config).toMatchObject({ enabled: false, allowedOrigins: [] });
    const learner = twinRouter.createCaller({ user: { ...user, ...f.learner, role: "user" } });
    await expect(learner.agents.update({ slug: f.twin.slug, widget: { allowedOrigins: [] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(twinRouter.createCaller({ user: null }).agents.update({ slug: f.twin.slug, widget: { allowedOrigins: [] } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
