import { fundOrg } from "../setup/meteroid";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { purchasePaid } from "@/lib/credit-purchases";
import { db, localMinutesDb, minutesFixture, type MinutesFixture } from "./minutes-test-db";
import { outsideServices } from "../flows/harness";

describe.skipIf(!localMinutesDb)("Meteroid purchase retries", () => {
  let f: MinutesFixture;
  const outside = outsideServices();
  beforeEach(async () => { outside.start(); f = minutesFixture(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 0 }); });
  afterEach(async () => { await f.clean(); outside.stop(); expect(outside.unexpected).toEqual([]); outside.reset(); });

  test("concurrent deliveries of the same payment are accepted as an idempotent retry", async () => {
    const purchase = await db.creditPurchase.create({ data: { orgId: f.org.id, credits: 100, amount: 80000, currency: "INR", kind: "payment_link", razorpayId: `plink_${f.org.id}` } });
    const input = { razorpayId: purchase.razorpayId!, paymentId: `pay_${f.org.id}`, amountPaid: 80000, currency: "INR" };
    const results = await Promise.allSettled([purchasePaid(input), purchasePaid(input)]);
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(results.filter((result) => result.status === "fulfilled" && !result.value.duplicate)).toHaveLength(1);
  });
});
