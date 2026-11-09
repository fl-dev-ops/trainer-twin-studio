import "./flow-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";
import { testDatabaseUrl } from "../setup/test-db-url";

describe.skipIf(!localMinutesDb)("flow: reconcile-purchases operator script safety and exit codes", () => {
  const f = minutesFixture();
  async function run(args: string[], databaseUrl = testDatabaseUrl(), keyId = "rzp_test_fake") {
    if (!databaseUrl) throw new Error("A local test database is required");
    const child = Bun.spawn([process.execPath, "--preload", "./tests/flows/fixtures/reconcile-razorpay.ts", "scripts/reconcile-purchases.ts", ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl, RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: "fake-secret" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  const snapshot = async () => ({
    purchases: await db.creditPurchase.findMany({ where: { orgId: f.org.id } }),
    ledger: await db.minuteLedger.findMany({ where: { orgId: f.org.id } }),
  });
  beforeAll(() => f.create());
  afterAll(() => f.clean());

  test("invalid age and refund windows are rejected with usage and no writes", async () => {
    const before = await snapshot();
    for (const args of [["--older-than", "-1"], ["--older-than", "NaN"], ["--refund-days", "0"], ["--refund-days", "-1"], ["--refund-days", "NaN"]]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("usage: bun scripts/reconcile-purchases.ts");
    }
    expect(await snapshot()).toEqual(before);
  });

  test("report mode needs neither --production nor the apply-only key guard, and exits zero with no events", async () => {
    const before = await snapshot();
    // These windows exclude fixture purchases in parallel flows; live-looking FAKE keys prove the write guard is skipped.
    const result = await run(["--older-than", "1000000", "--refund-days", "0.000000000001"], testDatabaseUrl(), "rzp_live_fake");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("REPORT · 0 purchase event(s) to look at");
    expect(await snapshot()).toEqual(before);
  });

  test("--apply refuses a non-local database without --production before connecting or writing", async () => {
    const before = await snapshot();
    const remote = new URL(testDatabaseUrl()!);
    remote.hostname = "database.invalid";
    const result = await run(["--apply"], remote.toString());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing: this is a production database; add --production");
    expect(result.stdout).not.toContain("APPLY");
    expect(await snapshot()).toEqual(before);
  });

  test.each(["--older-than", "--refund-days"])("BUG: %s without a value must be rejected, not silently defaulted", async (option) => {
    const before = await snapshot();
    const result = await run([option]);
    expect(await snapshot()).toEqual(before);
    expect(result.stderr).toContain("usage: bun scripts/reconcile-purchases.ts");
    expect(result.code).toBe(1);
  });

  test("a fake Razorpay error is printed and causes exit 1, without report-mode writes", async () => {
    const purchase = await db.creditPurchase.create({ data: {
      orgId: f.org.id, credits: 100, amount: 80000, currency: "INR", kind: "payment_link",
      razorpayId: `plink_script_${f.org.id}`, createdAt: new Date(Date.now() - 7_200_000),
    } });
    const before = await snapshot();
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("REPORT ·");
    expect(result.stdout).toContain(`error        ${f.org.slug} · ${purchase.razorpayId} · Razorpay /payment_links/${purchase.razorpayId}: fake subprocess Razorpay outage`);
    expect(await snapshot()).toEqual(before);
  });
});
