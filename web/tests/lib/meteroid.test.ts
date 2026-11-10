import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { verifyWebhook } from "@/lib/meteroid";

const now = 1_800_000_000_000;
const body = '{"type":"wallet.funded"}';
function signed(timestamp = String(now / 1000)) {
  const id = "msg_test";
  const key = Buffer.from(process.env.METEROID_WEBHOOK_SECRET!.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Headers({ "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` });
}

test("verifyWebhook accepts a valid Standard Webhooks signature, including rotated signatures", () => {
  const headers = signed();
  expect(verifyWebhook(body, headers, now)).toBe(true);
  headers.set("webhook-signature", `v1,wrong v2,ignored ${headers.get("webhook-signature")}`);
  expect(verifyWebhook(body, headers, now)).toBe(true);
});

test("verifyWebhook rejects missing, forged, tampered and old/future signatures", () => {
  expect(verifyWebhook(body, new Headers(), now)).toBe(false);
  expect(verifyWebhook(body + " ", signed(), now)).toBe(false);
  const headers = signed(); headers.set("webhook-signature", "v1,wrong");
  expect(verifyWebhook(body, headers, now)).toBe(false);
  for (const delta of [-301, 301]) expect(verifyWebhook(body, signed(String(now / 1000 + delta)), now)).toBe(false);
});

test("verifyWebhook refuses a nonnumeric timestamp even when correctly signed", () => {
  expect(verifyWebhook(body, signed("not-a-timestamp"), now)).toBe(false);
});
