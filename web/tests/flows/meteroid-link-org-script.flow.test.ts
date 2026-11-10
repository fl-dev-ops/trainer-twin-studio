import "./flow-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";
import { testDatabaseUrl } from "../setup/test-db-url";

describe.skipIf(!localMinutesDb)("flow: meteroid-link-org --trial validation", () => {
  const f = minutesFixture();
  const snapshot = async () => ({
    org: await db.organization.findUniqueOrThrow({ where: { id: f.org.id } }),
    billing: await db.orgBilling.findUnique({ where: { orgId: f.org.id } }),
  });
  beforeAll(() => f.create());
  afterAll(() => f.clean());

  test.each(["not-a-date", "2026-1-01", "2026-11-11T00:00:00Z"])("malformed --trial %j is refused with usage before writes or network requests", async (trial) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) throw new Error("A local test database is required");
    const before = await snapshot();
    const child = Bun.spawn([process.execPath, "--preload", "./tests/flows/fixtures/meteroid-link-org-network-guard.ts", "scripts/meteroid-link-org.ts", "--org", f.org.slug, "--trial", trial], {
      env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl, METEROID_API_KEY: "pv_dev_fake", METEROID_API_URL: "https://meteroid.test/api/v1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("error: usage: bun scripts/meteroid-link-org.ts --org <slug> [--trial <YYYY-MM-DD>]");
    expect(stderr).not.toContain("Unexpected meteroid-link-org script request");
    expect(stdout).toBe("");
    expect(await snapshot()).toEqual(before);
  });
});
