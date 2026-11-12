import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as delivery from "@/lib/send-email-now";
import { announceNewGrants } from "@/lib/org-credits-email";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";

describe.skipIf(!localMinutesDb)("org credits announcement (local database; send mocked)", () => {
  let f: MinutesFixture;
  let send: ReturnType<typeof spyOn<typeof delivery, "sendEmailNow">>;
  const grant = (id: string, minutes = 100) => ({ id, minutes, reason: "Pack", expiresAt: "2027-11-10T00:00:00Z", status: "ACTIVE", createdAt: "2026-11-10T00:00:00Z" });
  beforeEach(async () => {
    f = minutesFixture(); await f.create();
    send = spyOn(delivery, "sendEmailNow").mockResolvedValue({ success: true });
    await db.orgBilling.create({ data: { orgId: f.org.id, meteroidCustomerId: `customer_${f.org.id}`, balanceMinutes: 230, grants: [grant("old"), grant("g1"), grant("g2", 30), grant("zero", 0)], announcedGrantIds: ["old"] } });
  });
  afterEach(async () => { send?.mockRestore(); await f.clean(); });

  test("emails only the admin once per positive new grant, using org-credits:<grantId>; records announcedGrantIds", async () => {
    expect(await announceNewGrants(f.org.id)).toEqual({ announced: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    for (const [index, id, amount] of [[0, "g1", 100], [1, "g2", 30]] as const) {
      expect(send.mock.calls[index]).toEqual([
        { kind: "orgCredits", args: { to: f.trainer.email, orgName: f.org.name, added: amount, balance: 230, reason: "Pack", expires: "10 Nov 2027", creditsUrl: expect.stringMatching(/\/usage$/) } },
        `org-credits:${id}`,
      ]);
    }
    expect((await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).announcedGrantIds).toEqual(["old", "g1", "g2"]);
    expect(await announceNewGrants(f.org.id)).toEqual({ announced: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("failed send does not mark any grant announced; retry reuses the same idempotency key", async () => {
    send.mockResolvedValueOnce({ success: false, error: "Resend unavailable" });
    await expect(announceNewGrants(f.org.id)).rejects.toThrow("Resend unavailable");
    expect((await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).announcedGrantIds).toEqual(["old"]);
    expect(await announceNewGrants(f.org.id)).toEqual({ announced: 2 });
    expect(send.mock.calls.map((call) => call[1])).toEqual(["org-credits:g1", "org-credits:g1", "org-credits:g2"]);
  });

  test("missing billing has nothing to announce", async () => {
    await db.orgBilling.delete({ where: { orgId: f.org.id } });
    expect(await announceNewGrants(f.org.id)).toEqual({ announced: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
