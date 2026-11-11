import { beforeEach, expect, mock, test } from "bun:test";

let row = { kind: "renewal", status: "unpaid", dueDate: "2099-01-03" };
let paidKind: string | null = "upgrade";
const calls: string[] = [];
const waits: (Date | string)[] = [];
let paidAfter = 0; // checks that see "not paid yet" before the payment shows (Meteroid's API lags invoice.paid)
let overdueAction = "paused";
let failOverdue = false, failPaid = false, failPayLink = false;
const linkAndEmail: string[] = [];
mock.module("workflow", () => ({ sleep: async (at: Date | string) => { waits.push(at); } }));
mock.module("@/workflows/steps/billing", () => ({
  readInvoice: async (id: string) => { calls.push(`read:${id}`); return row; },
  payLink: async (id: string) => { linkAndEmail.push(`link:${id}`); if (failPayLink) throw new Error("Razorpay unavailable"); return "https://rzp.io/test"; },
  emailInvoice: async (id: string) => { linkAndEmail.push(`email:${id}`); calls.push(`email:${id}`); return true; },
  remind: async (id: string) => { calls.push(`remind:${id}`); return true; },
  handleOverdue: async (id: string) => { calls.push(`overdue:${id}`); if (failOverdue) throw new Error("cancellation incomplete"); return overdueAction; },
  handlePaid: async (id: string) => { calls.push(`paid:${id}`); if (failPaid) throw new Error("receipt email unavailable"); return calls.filter((c) => c.startsWith("paid:")).length > paidAfter ? paidKind : null; },
}));
const { invoiceIssued } = await import("@/workflows/invoice-issued");
const { invoicePaid } = await import("@/workflows/invoice-paid");
beforeEach(() => { calls.length = waits.length = linkAndEmail.length = 0; row = { kind: "renewal", status: "unpaid", dueDate: "2099-01-03" }; paidKind = "upgrade"; paidAfter = 0; overdueAction = "paused"; failOverdue = failPaid = failPayLink = false; });

test.each([false, true])("rules 27–28: payment link step precedes email; failure %s never blocks bank-transfer email", async (fails) => {
  row.kind = "pack"; failPayLink = fails;
  expect(await invoiceIssued("inv")).toEqual({ status: "emailed" });
  expect(linkAndEmail).toEqual(["link:inv", "email:inv"]);
});
test("rule 27: already paid invoice emails without creating a payment link", async () => {
  row.kind = "other"; row.status = "paid";
  await invoiceIssued("inv"); expect(linkAndEmail).toEqual(["email:inv"]);
});

test("rules 13–15: renewal emails at once, waits for UTC reminder then overdue", async () => {
  expect(await invoiceIssued("inv")).toEqual({ status: "paused" });
  expect(calls).toEqual(["read:inv", "email:inv", "remind:inv", "overdue:inv"]);
  expect(waits).toEqual([new Date("2099-01-02T00:00:00Z"), new Date("2099-01-04T00:00:00Z")]);
});
test("rule 12: upgrade has no reminder and waits to the day after due", async () => {
  row.kind = "upgrade";
  await invoiceIssued("inv");
  expect(calls).toEqual(["read:inv", "email:inv", "overdue:inv"]);
  expect(waits).toEqual([new Date("2099-01-04T00:00:00Z")]);
});
test.each(["pack", "other"])("rules 15, 19, 21: %s emailed but never schedules pausing", async (kind) => {
  row.kind = kind;
  expect(await invoiceIssued("inv")).toEqual({ status: "emailed" });
  expect(calls).toEqual(["read:inv", "email:inv"]); expect(waits).toEqual([]);
});
test("rule 24: void invoice never emailed or reminded", async () => {
  row.status = "void";
  expect(await invoiceIssued("inv")).toEqual({ status: "void" });
  expect(calls).toEqual(["read:inv"]); expect(waits).toEqual([]);
});
test("daily repair of overdue upgrade runs without sleeping in the past", async () => {
  row = { kind: "upgrade", status: "unpaid", dueDate: "2020-01-01" };
  await invoiceIssued("inv"); expect(waits).toEqual([]);
});
test.each(["upgrade", "renewal", "pack", "other"])("rules 11, 17, 19: paid workflow delegates %s once", async (kind) => {
  paidKind = kind;
  expect(await invoicePaid("inv")).toEqual({ status: "handled", kind });
  expect(calls).toEqual(["paid:inv"]);
  expect(waits).toEqual([]);
});
test("rule 24: invoice.paid before Meteroid's API shows it: re-checks every 10 s until it does", async () => {
  paidAfter = 2;
  expect(await invoicePaid("inv")).toEqual({ status: "handled", kind: "upgrade" });
  expect(calls).toEqual(["paid:inv", "paid:inv", "paid:inv"]);
  expect(waits).toEqual(["10s", "10s"]);
});
test.each(["none", "upgrade_cancelled"])("overdue workflow returns actual action %s, not a hard-coded pause", async (action) => {
  row = { kind: "upgrade", status: "unpaid", dueDate: "2020-01-01" }; overdueAction = action;
  expect(await invoiceIssued("inv")).toEqual({ status: action });
  expect(calls).toEqual(["read:inv", "email:inv", "overdue:inv"]); expect(waits).toEqual([]);
});
test("partial cancellation failure propagates from overdue step for durable retry", async () => {
  row = { kind: "upgrade", status: "unpaid", dueDate: "2020-01-01" }; failOverdue = true;
  await expect(invoiceIssued("inv")).rejects.toThrow("cancellation incomplete");
  expect(calls).toEqual(["read:inv", "email:inv", "overdue:inv"]); expect(waits).toEqual([]);
});
test("paid email failure throws for step retry, rather than becoming not_paid or a polling wait", async () => {
  failPaid = true;
  await expect(invoicePaid("inv")).rejects.toThrow("receipt email unavailable");
  expect(calls).toEqual(["paid:inv"]); expect(waits).toEqual([]);
  failPaid = false;
  expect(await invoicePaid("inv")).toEqual({ status: "handled", kind: "upgrade" });
  expect(calls).toEqual(["paid:inv", "paid:inv"]); expect(waits).toEqual([]);
});
test("rule 25: never shows paid: gives up after 12 checks (the daily check takes over)", async () => {
  paidKind = null;
  expect(await invoicePaid("inv")).toEqual({ status: "not_paid", kind: null });
  expect(calls).toHaveLength(12);
  expect(waits).toEqual(Array(12).fill("10s"));
});
