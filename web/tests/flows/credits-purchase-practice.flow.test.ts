import { fundOrg, availableOrgSeconds } from "../setup/meteroid";
import "./flow-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPaymentLinkPurchase } from "@/lib/credit-purchases";
import { learnerBalance } from "@/lib/minutes";
import { inviteToRoleplay } from "@/lib/invite/roleplay";
import { startSessionNow } from "@/lib/session-activation";
import { db, localMinutesDb, minutesFixture } from "../lib/minutes-test-db";
import { agentWebhook, outsideServices, practiceCode, razorpayWebhook } from "./harness";

/**
 * One org's whole story, step by step, each step on the state the last one left: it buys credits, assigns a learner a
 * role play, the learner practises (and rejoins after a reload), the call ends through the agent's webhook, they
 * practise again, and part of the purchase is refunded.
 */
describe.skipIf(!localMinutesDb)("flow: buy credits → assign → practise → refund", () => {
  const f = minutesFixture();
  const outside = outsideServices();
  const orgMinutes = async () => Math.floor((await availableOrgSeconds(f.org.id)) / 60);
  let code = "";
  let firstSession = "";

  beforeAll(async () => {
    outside.start();
    await f.create();
    await fundOrg({ orgId: f.org.id, minutes: 0 });
  });
  afterAll(async () => {
    await f.clean();
    outside.stop();
  });

  test("1. the org pays a ₹800 payment link for 100 credits", async () => {
    const purchase = await createPaymentLinkPurchase({ org: f.org, credits: 100, amount: 800, currency: "INR" });
    expect(outside.paymentLinks).toHaveLength(1);
    expect(outside.paymentLinks[0]).toMatchObject({ amount: 80000, currency: "INR", accept_partial: false, notes: { purchaseId: purchase.id } });
    expect(await orgMinutes()).toBe(0);

    const paid = await razorpayWebhook("payment_link.paid", {
      payment_link: { entity: { id: purchase.razorpayId } },
      payment: { entity: { id: "pay_flow1", amount: 80000, currency: "INR" } },
    });
    expect(paid.status).toBe(200);
    expect(await orgMinutes()).toBe(100);
  });

  test("2. the trainer assigns the role play with 10 starting credits; the learner's email says so", async () => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: f.roleplay.id }, select: { id: true, name: true, data: true } });
    await inviteToRoleplay({ org: f.org, by: { id: f.trainer.id, name: f.trainer.name }, agent, emails: [f.learner.email], startingMinutes: 10 });
    expect(await orgMinutes()).toBe(90);
    expect(Math.floor((await learnerBalance(f.org.id, f.learner.email)).balanceSeconds / 60)).toBe(10);

    expect(outside.emails).toHaveLength(1);
    const [email] = outside.emails;
    expect(email.to).toEqual([f.learner.email]);
    expect(email.subject).toBe(`New role play: ${f.roleplay.name}`);
    expect(email.text).toContain("Your balance: 10 credits");
    expect(email.text).toContain(`Sign in with Google or an email code, using ${f.learner.email}`);
    code = practiceCode(email);
  });

  test("3. the learner starts the call with 10 minutes on the clock; a reload rejoins the same call", async () => {
    const start = () => startSessionNow({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: code, mode: "voice" });
    const first = await start();
    if (!first.ok) throw new Error(first.error);
    expect(first?.session.status).toBe("active");
    expect(first?.session.secondsLeft).toBe(600);
    expect(outside.livekit).toContain("CreateDispatch");
    expect(outside.chatSessions).toContain(first!.session.id);
    firstSession = first!.session.id;

    const again = await start();
    if (!again.ok) throw new Error(again.error);
    expect(again?.session.id).toBe(firstSession);
  });

  test("4. the agent ends the call after 3 minutes: 3 minutes used, the assignment is practised", async () => {
    await db.interviewSession.update({ where: { id: firstSession }, data: { startedAt: new Date(Date.now() - 180_000) } });
    const ended = await agentWebhook(firstSession);
    expect(ended.status).toBe(200);
    const learner = await learnerBalance(f.org.id, f.learner.email);
    expect(Math.round(learner.usedSeconds / 60)).toBe(3);
    expect(Math.floor(learner.balanceSeconds / 60)).toBe(7);
    expect((await db.rolePlayAssignment.findFirstOrThrow({ where: { orgId: f.org.id } })).status).toBe("used");
  });

  test("5. the same link starts a new call, with the 7 minutes left", async () => {
    const second = await startSessionNow({ orgId: f.org.id, userId: f.learner.id, userEmail: f.learner.email, shareCode: code, mode: "voice" });
    if (!second.ok) throw new Error(second.error);
    expect(second?.session.id).not.toBe(firstSession);
    expect(second?.session.secondsLeft).toBeGreaterThan(400);
    expect(second?.session.secondsLeft).toBeLessThanOrEqual(420);
  });

  test("6. half the payment is refunded: credits stay with the org", async () => {
    const refunded = await razorpayWebhook("refund.processed", { refund: { entity: { id: "rfnd_flow1", payment_id: "pay_flow1", amount: 40000, currency: "INR" } } });
    expect(refunded.status).toBe(200);
    expect(await orgMinutes()).toBe(90);
  });

  test("nothing reached an outside service the flow didn't expect", () => {
    expect(outside.unexpected).toEqual([]);
  });
});
