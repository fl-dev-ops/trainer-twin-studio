import { beforeEach, expect, mock, test } from "bun:test";
const calls: unknown[][] = [];
let customer: string | null = "customer";
let chromaFailure = false;
mock.module("@/workflows/steps/onboarding", () => ({
  createChromaDatabase: async (id: string) => { calls.push(["chroma", id]); if (chromaFailure) throw new Error("quota"); },
  createBillingCustomer: async (id: string) => { calls.push(["billing", id]); return customer; },
  grantTrial: async (id: string, customerId: string) => { calls.push(["trial", id, customerId]); },
}));
const { onboardOrg } = await import("@/workflows/onboard-org");
beforeEach(() => { calls.length = 0; customer = "customer"; chromaFailure = false; });
test("onboardOrg creates Chroma, then billing, then trial credits in order", async () => {
  expect(await onboardOrg("org")).toEqual({ ok: true, meteroidCustomerId: "customer" });
  expect(calls).toEqual([["chroma", "org"], ["billing", "org"], ["trial", "org", "customer"]]);
});
test("onboardOrg skips trial grant when billing is unconfigured", async () => {
  customer = null;
  expect(await onboardOrg("org")).toEqual({ ok: true, meteroidCustomerId: null });
  expect(calls).toEqual([["chroma", "org"], ["billing", "org"]]);
});
test("onboardOrg propagates Chroma failure without creating billing or trial credits", async () => {
  chromaFailure = true;
  await expect(onboardOrg("org")).rejects.toThrow("quota");
  expect(calls).toEqual([["chroma", "org"]]);
});
