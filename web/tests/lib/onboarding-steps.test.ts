import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ChromaTenantService } from "@/lib/chroma-tenant";
const org = { id: "org", slug: "training", name: "Training", createdAt: new Date("2026-01-01T00:00:00Z") };
const findUniqueOrThrow = mock(async (_input: unknown) => org);
const linkOrgToMeteroid = mock(async (_org: unknown) => ({ customerId: "customer", subscriptionId: "subscription" }));
const grantTrialMinutes = mock(async (_org: unknown, _customer: string) => {});
mock.module("@/lib/db", () => ({ db: { organization: { findUniqueOrThrow } } }));
mock.module("@/lib/org-billing-setup", () => ({ linkOrgToMeteroid, grantTrialMinutes }));
const { createChromaDatabase, createBillingCustomer, grantTrial } = await import("@/workflows/steps/onboarding");
let chroma: ReturnType<typeof spyOn<typeof ChromaTenantService, "createOrgDatabase">>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
const key = process.env.METEROID_API_KEY;
beforeEach(() => {
  for (const fn of [findUniqueOrThrow, linkOrgToMeteroid, grantTrialMinutes]) fn.mockClear();
  chroma = spyOn(ChromaTenantService, "createOrgDatabase").mockResolvedValue(undefined as never);
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  chroma.mockRestore(); warn.mockRestore();
  if (key === undefined) delete process.env.METEROID_API_KEY; else process.env.METEROID_API_KEY = key;
});
test("createChromaDatabase delegates to tenant provisioning", async () => {
  await createChromaDatabase(org.id);
  expect(chroma).toHaveBeenCalledTimes(1);
  expect(chroma).toHaveBeenCalledWith(org.id);
});
test("createBillingCustomer is skipped without a nonblank key", async () => {
  process.env.METEROID_API_KEY = " ";
  expect(await createBillingCustomer(org.id)).toBeNull();
  expect(findUniqueOrThrow).not.toHaveBeenCalled();
  expect(linkOrgToMeteroid).not.toHaveBeenCalled();
});
test("createBillingCustomer loads org and returns the linked customer", async () => {
  process.env.METEROID_API_KEY = "test-key";
  expect(await createBillingCustomer(org.id)).toBe("customer");
  expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: org.id }, select: { id: true, slug: true, name: true } });
  expect(linkOrgToMeteroid).toHaveBeenCalledWith(org);
});
test("grantTrial loads stable org creation time before granting", async () => {
  await grantTrial(org.id, "customer");
  expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: org.id }, select: { id: true, createdAt: true } });
  expect(grantTrialMinutes).toHaveBeenCalledTimes(1);
  expect(grantTrialMinutes).toHaveBeenCalledWith(org, "customer");
});
