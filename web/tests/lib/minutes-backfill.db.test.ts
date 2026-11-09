import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { orgBalanceSeconds } from "@/lib/minutes";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

async function backfill(args: string[], env = process.env) {
  const child = Bun.spawn([process.execPath, "scripts/minutes-backfill.ts", ...args], {
    cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

describe.skipIf(!localMinutesDb)("minutes backfill script (local database)", () => {
  let f: MinutesFixture;
  beforeEach(async () => { f = minutesFixture(); await f.create(); });
  afterEach(async () => { await f.clean(); });

  test("default dry run writes nothing; apply adds 1000 and grants 60; re-run skips", async () => {
    const dry = await backfill(["--org", f.org.slug]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("DRY RUN");
    expect(dry.stdout).toContain("1 learner(s) × 60 min");
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
    const applied = await backfill(["--apply", "--org", f.org.slug]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("written");
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id }, select: { type: true, seconds: true, email: true }, orderBy: { seconds: "desc" } }))
      .toEqual([{ type: "topup", seconds: 60_000, email: null }, { type: "grant", seconds: 3600, email: f.learner.email }]);
    expect(await orgBalanceSeconds(f.org.id)).toBe(940 * 60);
    const rerun = await backfill(["--apply", "--org", f.org.slug]);
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stdout).toContain("skipped (already has 2 ledger rows");
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(2);
  }, 30_000);

  test("normalizes/deduplicates pending invitations and excludes studio and disabled people", async () => {
    await db.member.update({ where: { id: `${f.learner.id}-member` }, data: { disabledAt: new Date() } });
    const newEmail = `new-${f.learner.email}`;
    const emails = [newEmail, newEmail.toUpperCase(), f.trainer.email, f.learner.email];
    await db.invitation.createMany({ data: emails.map((email, i) => ({ id: `${f.org.id}-${i}`, organizationId: f.org.id, inviterId: f.trainer.id, email, role: "user", status: "pending", expiresAt: new Date(Date.now() + 3600_000) })) });
    const result = await backfill(["--apply", "--org", f.org.slug]);
    expect(result.exitCode).toBe(0);
    expect(await db.minuteLedger.findMany({ where: { orgId: f.org.id, type: "grant" }, select: { email: true, seconds: true } })).toEqual([{ email: newEmail, seconds: 3600 }]);
  }, 20_000);

  test("over-capacity org is not partially written", async () => {
    await db.invitation.createMany({ data: Array.from({ length: 16 }, (_, i) => ({ id: `${f.org.id}-${i}`, organizationId: f.org.id, inviterId: f.trainer.id, email: `${i}-${f.learner.email}`, role: "user", status: "pending", expiresAt: new Date(Date.now() + 3600_000) })) });
    const result = await backfill(["--apply", "--org", f.org.slug]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("NOT WRITTEN");
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  }, 20_000);

  test("production-looking URL is refused before any connection without --production", async () => {
    // Any host but this machine counts as production; .invalid never resolves, so nothing can connect anyway.
    const result = await backfill(["--apply", "--org", f.org.slug], { ...process.env, DATABASE_URL: "postgresql://fake:fake@prod.invalid:5432/db" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing: this is a production database; add --production");
    expect(result.stderr).not.toContain("ECONNREFUSED");
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  }, 20_000);
});
