import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET } from "@/app/embed/[agentId]/route";
import { BASE_DOMAIN } from "@/lib/base-domain";
import { db, localMinutesDb, minutesFixture, setTwinPublic, type MinutesFixture } from "../lib/minutes-test-db";

describe.skipIf(!localMinutesDb)("hosted widget security (real database)", () => {
  let f: MinutesFixture;
  const origins = ["https://customer.example", "https://other.example:8443", "http://localhost:4312"];
  const xss = '</script><script>alert("xss")</script>&\u2028\u2029';
  const settings = () => ({
    publicAccess: { enabled: true, maxSeconds: 300 as const },
    widget: { allowedOrigins: origins, welcome: xss, accentColor: "#123456" },
  });
  beforeEach(async () => {
    f = minutesFixture();
    await f.create();
    // The bot takes the twin's name and data when it is made (lib/bots).
    await db.agent.update({ where: { id: f.twin.id }, data: { name: xss, data: { privateInstructions: "never-expose-private-instructions" } } });
    await setTwinPublic(f, settings());
  });
  afterEach(async () => { await f.clean(); });
  const page = (parent: string | null = origins[0], agentId = f.twin.id, host = `${f.org.slug}.${BASE_DOMAIN}`) => {
    const url = new URL(`https://${host}/embed/${agentId}`);
    if (parent !== null) url.searchParams.set("parentOrigin", parent);
    return GET(new Request(url, { headers: { host } }), { params: Promise.resolve({ agentId }) });
  };
  test.each(origins)("exact dynamic frame-ancestors includes every configured origin for %s", async (origin) => {
    const response = await page(origin);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp.split("; ")[0]).toBe(`frame-ancestors ${origins.join(" ")}`);
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(response.headers.get("permissions-policy")).toBe("microphone=(self), camera=(), display-capture=(), geolocation=()");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await db.interviewSession.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("name/welcome are JSON data, never executable HTML; private config and credentials absent", async () => {
    const html = await (await page()).text();
    expect(html).not.toContain(xss);
    expect(html).not.toContain('<script>alert("xss")');
    const match = /<script id="trainertwin-config" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toMatchObject({ name: xss, welcome: xss.trim(), parentOrigin: origins[0] });
    expect(html).not.toContain("never-expose-private-instructions");
    expect(html).not.toMatch(/agentToken|runtimeToken|visitorToken|embedToken|COPILOT_SERVICE_SECRET/);
    if (process.env.COPILOT_SERVICE_SECRET) expect(html).not.toContain(process.env.COPILOT_SERVICE_SECRET);
  });
  test.each([null, "", "https://evil.example", "https://customer.example.evil.example", "https://customer.example:8443", "https://customer.example/path", "null"])("widget_unavailable: direct/unallowed parent %s", async (parent) => {
    const response = await page(parent);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(await response.text()).not.toContain("trainertwin-config");
  });
  test.each(["widget-off", "public-off", "archived", "removed-origin"])("unavailable hosted page after %s", async (kind) => {
    if (kind === "widget-off") await setTwinPublic(f, { widget: { allowedOrigins: [] } });
    if (kind === "public-off") await setTwinPublic(f, { publicAccess: { enabled: false } });
    if (kind === "removed-origin") await setTwinPublic(f, { widget: { allowedOrigins: [origins[1]] } });
    if (kind === "archived") await db.agent.update({ where: { id: f.twin.id }, data: { archivedAt: new Date() } });
    const response = await page();
    expect(response.status).toBe(kind === "archived" ? 404 : 403);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
  test("unknown agent and wrong org never serve widget config", async () => {
    expect((await page(origins[0], f.roleplay.id)).status).toBe(404);
    expect((await page(origins[0], "missing")).status).toBe(404);
    expect((await page(origins[0], f.twin.id, `missing.${BASE_DOMAIN}`)).status).toBe(404);
  });
});
