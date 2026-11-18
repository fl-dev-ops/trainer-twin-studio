import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateTwin } from "@/lib/twin/manage";
import { widgetSettings } from "@/lib/widget-settings";
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
  const current = () => db.agent.findUniqueOrThrow({ where: { id: f.twin.id } });

  test("merges partial updates, snapshots and preserves widget on other saves", async () => {
    await updateTwin(f.org.id, f.twin.slug, { widget: { allowedOrigins: ["https://EXAMPLE.com:443"], welcome: "Ask Alex", accentColor: "#AABBCC" } });
    const first = await current();
    expect(widgetSettings(first.data)).toEqual({ enabled: false, allowedOrigins: ["https://example.com"], welcome: "Ask Alex", accentColor: "#aabbcc" });
    await updateTwin(f.org.id, f.twin.slug, { widget: { enabled: true } });
    const enabled = await current();
    expect(widgetSettings(enabled.data).enabled).toBe(true);
    await updateTwin(f.org.id, f.twin.slug, { description: "Updated knowledge", publicAccess: { enabled: true } });
    const updated = await current();
    expect(widgetSettings(updated.data)).toEqual(widgetSettings(enabled.data));
    expect(updated.version).toBe(first.version + 2);
    const snapshot = await db.specVersion.findFirstOrThrow({ where: { orgId: f.org.id, entitySlug: f.twin.slug, version: enabled.version } });
    expect(widgetSettings(snapshot.data)).toEqual(widgetSettings(enabled.data));
    const unchanged = await updateTwin(f.org.id, f.twin.slug, { widget: { welcome: "Ask Alex" } });
    expect(unchanged.changed).toBe(false);
  });

  test("refuses enable without origin and clearing an enabled allowlist atomically", async () => {
    const original = await current();
    await expect(updateTwin(f.org.id, f.twin.slug, { widget: { enabled: true } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await current()).version).toBe(original.version);
    await updateTwin(f.org.id, f.twin.slug, { widget: { enabled: true, allowedOrigins: ["https://example.com"] } });
    const enabled = await current();
    await expect(updateTwin(f.org.id, f.twin.slug, { name: "Must not persist", widget: { allowedOrigins: [] } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await current()).toMatchObject({ name: enabled.name, version: enabled.version, data: enabled.data });
    await updateTwin(f.org.id, f.twin.slug, { widget: { enabled: false, allowedOrigins: [] } });
    expect(widgetSettings((await current()).data).enabled).toBe(false);
  });

  test("does not enable public access as a side effect", async () => {
    await updateTwin(f.org.id, f.twin.slug, { widget: { enabled: true, allowedOrigins: ["https://example.com"] } });
    expect((await current()).data).not.toHaveProperty("publicAccess");
    await updateTwin(f.org.id, f.twin.slug, { publicAccess: { enabled: false } });
    expect(widgetSettings((await current()).data).enabled).toBe(true);
  });

  test("enforces org scope and rejects malformed origins before versioning", async () => {
    await expect(updateTwin("different-org", f.twin.slug, { widget: { enabled: true } })).rejects.toMatchObject({ code: "not_found" });
    const before = await current();
    await expect(updateTwin(f.org.id, f.twin.slug, { widget: { allowedOrigins: ["https://*.example.com"] } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await current()).version).toBe(before.version);
    expect(await db.specVersion.count({ where: { orgId: f.org.id } })).toBe(0);
  });

  test("studio API accepts partial updates and returns the stable ID and own-host origin", async () => {
    const user = { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" };
    const caller = twinRouter.createCaller({ user });
    await caller.agents.update({ slug: f.twin.slug, widget: { allowedOrigins: ["https://example.com"] } });
    await caller.agents.update({ slug: f.twin.slug, widget: { enabled: true } });
    const twin = await caller.agents.get({ slug: f.twin.slug });
    expect(twin.widget).toMatchObject({ id: f.twin.id, config: { enabled: true, allowedOrigins: ["https://example.com"] } });
    expect(new URL(twin.widget.origin).hostname.startsWith(`${f.org.slug}.`)).toBe(true);
    expect(twin.publicAccess.enabled).toBe(false);
    await expect(caller.agents.update({ slug: f.twin.slug, widget: { allowedOrigins: [] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const learner = twinRouter.createCaller({ user: { ...user, ...f.learner, role: "user" } });
    await expect(learner.agents.update({ slug: f.twin.slug, widget: { enabled: false } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(twinRouter.createCaller({ user: null }).agents.update({ slug: f.twin.slug, widget: { enabled: false } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
