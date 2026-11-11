import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { e2eUrl } from "./env";
import { as, seed } from "./seed-data";

test.use(as("admin"));

test("Payments: signed grant, duplicate delivery, partial refund and forged signature", async ({ page, request }) => {
  const { purchase } = seed();
  const post = (event: string, payload: Record<string, unknown>, forged = false) => {
    const raw = JSON.stringify({ event, payload });
    const signature = createHmac("sha256", "test-webhook-secret").update(raw).digest("hex");
    return request.post(e2eUrl("dash", "/api/razorpay/webhook"), {
      data: raw, headers: { "content-type": "application/json", "x-razorpay-signature": forged ? "0".repeat(64) : signature },
    });
  };
  const payment = {
    payment_link: { entity: { id: purchase.razorpayId, notes: { purchaseId: purchase.id } } },
    payment: { entity: { id: purchase.paymentId, amount: 80000, currency: "INR" } },
  };
  await page.goto("/usage");
  const remaining = page.locator("section").filter({ has: page.getByText("Remaining credits", { exact: true }) }).locator("p").nth(1);
  await expect(remaining).toHaveText(/[\d,]+ min/);
  const before = Number((await remaining.innerText()).replace(/[^\d]/g, ""));
  const showHistory = async () => {
    await page.reload();
  };
  const topup = page.getByRole("region", { name: "Credits added" }).locator("li").filter({ hasText: `Paid ₹800 · Razorpay ${purchase.razorpayId}` });

  const paid = await post("payment_link.paid", payment);
  expect(paid.status()).toBe(200);
  expect(await paid.json()).toMatchObject({ ok: true, result: { duplicate: false } });
  await showHistory();
  await expect(remaining).toHaveText(`${before + 100} min`);
  await expect(topup).toHaveCount(1);
  await expect(topup).toContainText("+100 min");

  const duplicate = await post("payment_link.paid", payment);
  expect(duplicate.status()).toBe(200);
  expect(await duplicate.json()).toMatchObject({ result: { duplicate: true } });
  await showHistory();
  await expect(remaining).toHaveText(`${before + 100} min`);
  await expect(topup).toHaveCount(1);

  const refunded = await post("refund.processed", {
    refund: { entity: { id: purchase.refundId, payment_id: purchase.paymentId, amount: 20000, currency: "INR" } },
  });
  expect(refunded.status()).toBe(200);
  expect(await refunded.json()).toMatchObject({ ok: true, result: { creditsTakenBack: 0 } });
  await showHistory();
  await expect(remaining).toHaveText(`${before + 100} min`);
  await expect(page.locator("main li").filter({ hasText: `Refund ₹200` })).toHaveCount(0);
  await expect(topup).toHaveCount(1);
  await expect(page.getByRole("tabpanel").locator("li")).toHaveCount(2);

  // A different refund id would not be a duplicate: only the signature must prevent this new refund.
  const forged = await post("refund.processed", {
    refund: { entity: { id: `${purchase.refundId}_forged`, payment_id: purchase.paymentId, amount: 20000, currency: "INR" } },
  }, true);
  expect(forged.status()).toBe(401);
  expect(await forged.json()).toEqual({ error: "Invalid signature" });
  await showHistory();
  await expect(remaining).toHaveText(`${before + 100} min`);
  await expect(page.getByRole("tabpanel").locator("li")).toHaveCount(2);
  await expect(topup).toHaveCount(1);
  await expect(page.locator("main li").filter({ hasText: "Starting balance" })).toHaveCount(1);
});
