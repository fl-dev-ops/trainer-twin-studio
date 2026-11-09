import "./flow-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { minutesRouter } from "@/lib/minutes-trpc";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";
import { testDatabaseUrl } from "../setup/test-db-url";

/** TrainerTwin records an invoice, then another top-up; every addition remains its own immutable history row. */
describe.skipIf(!localMinutesDb)("flow: TrainerTwin tops up an org through the operator script", () => {
  const f = minutesFixture();
  const api = minutesRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
  const rows = () => db.minuteLedger.findMany({ where: { orgId: f.org.id }, orderBy: { id: "asc" } });
  async function run(args: string[], databaseUrl = testDatabaseUrl()) {
    if (!databaseUrl) throw new Error("A local test database is required");
    const child = Bun.spawn(["bun", "scripts/org-topup.ts", ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl, RESEND_API_KEY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  const args = (minutes: string, note = "Invoice 42") => ["--org", f.org.slug, "--minutes", minutes, "--note", note];
  beforeAll(() => f.create());
  afterAll(() => f.clean());

  test("1. Invoice 42 adds 300 credits with no actor (the UI calls this TrainerTwin)", async () => {
    expect((await api.org()).balanceMinutes).toBe(0);
    const result = await run(args("300"));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("+300 min · balance 300 min");
    expect(await api.org()).toMatchObject({ balanceMinutes: 300, addedMinutes: 300, topups: [{ minutes: 300, note: "Invoice 42", by: null }] });
    expect(await rows()).toEqual([expect.objectContaining({ type: "topup", seconds: 18000, note: "Invoice 42", actorUserId: null })]);
  });

  test("2. a second invoice appends without changing the first row", async () => {
    const [first] = await rows();
    expect((await run(args("50", "Invoice 43"))).code).toBe(0);
    expect(await rows()).toHaveLength(2);
    expect(await db.minuteLedger.findUnique({ where: { id: first.id } })).toEqual(first);
    expect(await api.org()).toMatchObject({ balanceMinutes: 350, addedMinutes: 350, topups: expect.arrayContaining([
      expect.objectContaining({ minutes: 300, note: "Invoice 42", by: null }),
      expect.objectContaining({ minutes: 50, note: "Invoice 43", by: null }),
    ]) });
  });

  test("3. missing arguments and invalid amounts are refused without writes", async () => {
    const before = await rows();
    for (const invalid of [[], ["--org", f.org.slug], args("0"), args("-1"), args("1.5"), args("NaN"), args("30", "")]) {
      const result = await run(invalid);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("usage:");
      expect(await rows()).toEqual(before);
    }
  });

  test("4. a non-local URL is refused without --production, before connecting or writing", async () => {
    const before = await rows();
    // Unresolvable, deliberately not a real remote database; even a broken guard cannot reach production.
    const remote = new URL(testDatabaseUrl()!);
    remote.hostname = "database.invalid";
    const result = await run(args("300"), remote.toString());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("refusing: this is a production database; add --production");
    expect(result.stderr).not.toContain("Can't reach database");
    expect(await rows()).toEqual(before);
  });
});
