import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { PDFDocument } from "pdf-lib";
import * as nextHeaders from "next/headers";
import * as org from "@/lib/org";
import { billingRouter } from "@/lib/billing/trpc";
import { billingOverview, invoicePdfFor, paidSubscriptionEnded, receiptPdfFor } from "@/lib/billing/billing";
import { pausedReason } from "@/lib/billing/paused";
import { minutesRouter } from "@/lib/minutes-trpc";
import { GET as invoiceDownload } from "@/app/api/billing/invoices/[id]/pdf/route";
import { GET as receiptDownload } from "@/app/api/billing/invoices/[id]/receipt/route";
import { GET as cronCheck, POST as cronPost } from "@/app/api/internal/billing/check/route";
import { db, localMinutesDb, minutesFixture, meteroidServer, type MinutesFixture } from "./minutes-test-db";
import { fundOrg } from "../setup/meteroid";
import { seller, sellerReply } from "../setup/billing-meteroid-fixture";
import * as billingMeteroid from "@/lib/billing/meteroid";
import { s3Configured } from "@/lib/s3";

const details = { legalName: "DB Billing Ltd", country: "US", line1: "10 Street", city: "Boston", postalCode: "02110", emails: ["billing@example.com"], phone: "+19876543210" };

describe.skipIf(!localMinutesDb)("billing phase 2 constraints and studio API (local database)", () => {
  let f: MinutesFixture;
  let membership: ReturnType<typeof spyOn<typeof org, "currentMembership">>;
  let headers: ReturnType<typeof spyOn<typeof nextHeaders, "headers">>;
  const env = { CRON_SECRET: process.env.CRON_SECRET, INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET, VERCEL: process.env.VERCEL, METEROID_GRPC_URL: process.env.METEROID_GRPC_URL };
  const caller = (role = "admin", orgId = f.org.id) => billingRouter.createCaller({ user: { ...f.trainer, orgId, orgSlug: f.org.slug, role } });
  const invoiceData = () => ({ id: `invoice-${f.org.id}`, orgId: f.org.id, number: "INV-DB-001", kind: "other", status: "unpaid", totalCents: 2500, currency: "USD", issuedAt: new Date("2026-11-01"), dueDate: new Date("2026-11-03") });
  function identity(role: string | null, orgId = f.org.id) {
    membership.mockResolvedValue(role === null ? null : { session: { user: f.trainer }, member: { role, organization: { ...f.org, id: orgId, metadata: null } } } as Awaited<ReturnType<typeof org.currentMembership>>);
  }
  const download = (route: typeof invoiceDownload, id = invoiceData().id) => route(new Request("http://dash.test/api/billing/invoices/id"), { params: Promise.resolve({ id }) });
  beforeEach(async () => {
    process.env.METEROID_GRPC_URL = "https://meteroid-grpc.test";
    f = minutesFixture(); await f.create(); await fundOrg({ orgId: f.org.id, minutes: 0 });
    headers = spyOn(nextHeaders, "headers").mockResolvedValue(new Headers());
    membership = spyOn(org, "currentMembership"); identity("admin");
    meteroidServer.use(
      http.post("https://meteroid-grpc.test/meteroid.api.invoicingentities.v1.InvoicingEntitiesService/GetInvoicingEntity", () => new HttpResponse(sellerReply())),
      http.get("https://meteroid.test/api/v1/invoices/:id", ({ params }) => HttpResponse.json({
        id: params.id, invoice_number: "INV-DB-001", invoice_date: "2026-11-01", due_date: "2026-11-03", currency: "USD", subtotal: 2500, tax_amount: 0, total: 2500,
        customer_details: { name: "Invoice-time DB Ltd", email: "billing@example.com", billing_address: { line1: "10 Street", city: "Boston", zip_code: "02110", country: "US" } },
        line_items: [{ name: "Purchase credits", quantity: "100", unit_price: "0.25" }],
        transactions: [{ status: "SETTLED", payment_type: "PAYMENT", provider_transaction_id: "bank-ref", amount: 2500, processed_at: "2026-11-02T10:00:00Z" }],
      })),
      http.get("https://meteroid.test/api/v1/invoices", () => HttpResponse.json({ data: [] })),
    );
  });
  afterEach(async () => {
    membership.mockRestore(); headers.mockRestore(); meteroidServer.resetHandlers();
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await f.clean();
  });

  test.each(["overview", "saveDetails", "buyPacks"] as const)("rule 5: learner FORBIDDEN on billing.%s", async (procedure) => {
    const api = caller("user");
    const call = procedure === "overview" ? api.overview() : procedure === "saveDetails" ? api.saveDetails({ details }) : api.buyPacks({ packs: 1, requestId: randomUUID() });
    await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).billingDetails).toBeNull();
  });
  test.each(["admin", "team"])("rule 5: %s can overview and save billing details", async (role) => {
    meteroidServer.use(http.patch("https://meteroid.test/api/v1/customers/:id", () => HttpResponse.json({})));
    expect(await caller(role).overview()).toMatchObject({ billed: true, plan: "trial" });
    expect(await caller(role).saveDetails({ details })).toEqual(details);
  });
  test("rule 7: saveDetails rejects unknown fields without patching Meteroid or saving details", async () => {
    let patches = 0;
    meteroidServer.use(http.patch("https://meteroid.test/api/v1/customers/:id", () => { patches++; return HttpResponse.json({}); }));
    await expect(caller().saveDetails({ details: { ...details, hacker: 1 } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(patches).toBe(0);
    expect((await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).billingDetails).toBeNull();
  });
  test("rule 10: the studio billing router has no self-serve upgrade procedure", () => {
    expect(billingRouter._def.procedures).not.toHaveProperty("upgrade");
  });
  test("billingOverview planCents is the latest non-void plan invoice, not packs, other invoices or old subscriptions", async () => {
    const current = `paid-${f.org.id}`;
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: current } });
    for (const [suffix, kind, status, subscriptionId, totalCents, issuedOn] of [
      ["upgrade", "upgrade", "paid", current, 12345, "2026-10-01"],
      ["renewal", "renewal", "unpaid", current, 23456, "2026-11-01"],
      ["void", "renewal", "void", current, 34567, "2026-11-02"],
      ["other", "other", "unpaid", current, 45678, "2026-11-03"],
      ["pack", "pack", "paid", null, 2500, "2026-11-04"],
      ["old-sub", "renewal", "paid", "old-subscription", 56789, "2026-11-05"],
    ] as const) await db.billingInvoice.create({ data: { ...invoiceData(), id: `${invoiceData().id}-${suffix}`, kind, status, subscriptionId, totalCents, issuedAt: new Date(issuedOn) } });
    const overview = await billingOverview(f.org.id);
    expect(overview).toMatchObject({ planCents: 23456 });
    expect(overview).not.toHaveProperty("monthlyCents");
    await db.billingInvoice.update({ where: { id: `${invoiceData().id}-renewal` }, data: { status: "void" } });
    expect(await billingOverview(f.org.id)).toMatchObject({ planCents: 12345 });
    await db.billingInvoice.update({ where: { id: `${invoiceData().id}-upgrade` }, data: { status: "unpaid" } });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "trial" } });
    expect(await billingOverview(f.org.id)).toMatchObject({ planCents: 12345 }); // pending staff upgrade
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { paidSubscriptionId: null } });
    expect(await billingOverview(f.org.id)).toMatchObject({ planCents: null });
  });
  test("billingOverview renewsOn is latest non-void current period end, not latest issued invoice; Trial has none", async () => {
    const current = `paid-${f.org.id}`;
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: current } });
    for (const [suffix, issuedAt, periodEnd, status, subscriptionId] of [
      ["long", "2026-10-01", "2027-01-01", "paid", current],
      ["recent", "2026-11-01", "2026-12-01", "unpaid", current],
      ["void", "2026-11-02", "2027-03-01", "void", current],
      ["old-sub", "2026-11-03", "2027-04-01", "paid", "old-subscription"],
      ["no-period", "2026-11-04", null, "unpaid", current],
    ] as const) await db.billingInvoice.create({ data: { ...invoiceData(), id: `${invoiceData().id}-${suffix}`, kind: "renewal", subscriptionId, status, issuedAt: new Date(issuedAt), periodEnd: periodEnd ? new Date(periodEnd) : null } });
    expect(await billingOverview(f.org.id)).toMatchObject({ renewsOn: "2027-01-01" });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "trial" } });
    expect(await billingOverview(f.org.id)).toMatchObject({ renewsOn: null });
  });
  test("billingOverview overdueInvoice and dueInvoice ignore newer invoices of an old subscription", async () => {
    const current = `paid-${f.org.id}`;
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: current } });
    for (const [suffix, subscriptionId, dueDate, issuedAt] of [
      ["current-overdue", current, "2026-11-03", "2026-10-01"],
      ["current-due", current, "2026-11-07", "2026-10-02"],
      ["old-overdue", "old-subscription", "2026-11-03", "2026-11-01"],
      ["old-due", "old-subscription", "2026-11-07", "2026-11-02"],
    ] as const) await db.billingInvoice.create({ data: { ...invoiceData(), id: suffix, kind: "renewal", subscriptionId, dueDate: new Date(dueDate), issuedAt: new Date(issuedAt) } });
    expect(await billingOverview(f.org.id, new Date("2026-11-04"))).toMatchObject({ overdueInvoice: { id: "current-overdue" }, dueInvoice: { id: "current-due" }, invoices: expect.arrayContaining([expect.objectContaining({ id: "old-overdue" })]) });
    await db.billingInvoice.updateMany({ where: { orgId: f.org.id, subscriptionId: current }, data: { status: "paid" } });
    expect(await billingOverview(f.org.id, new Date("2026-11-04"))).toMatchObject({ overdueInvoice: null, dueInvoice: null });
  });
  test("tRPC maps BillingError 400/404/409/502 to BAD_REQUEST/NOT_FOUND/CONFLICT/BAD_GATEWAY", async () => {
    const buy = (api = caller()) => api.buyPacks({ packs: 1, requestId: randomUUID() });
    await expect(buy()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(buy(caller("admin", "not-billed"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { billingDetails: details } });
    await expect(buy()).rejects.toMatchObject({ code: "CONFLICT" });
    meteroidServer.use(http.patch("https://meteroid.test/api/v1/customers/:id", () => new HttpResponse(null, { status: 503 })));
    await expect(caller().saveDetails({ details })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });
  test.each([{ packs: 0, requestId: randomUUID() }, { packs: 11, requestId: randomUUID() }, { packs: 1.5, requestId: randomUUID() }, { packs: 1, requestId: "not-uuid" }])("pack tRPC validates %j before external work", async (input) => {
    await expect(caller().buyPacks(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  test("unauthenticated billing API is UNAUTHORIZED, signed in without org is FORBIDDEN", async () => {
    await expect(billingRouter.createCaller({ user: null }).overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(billingRouter.createCaller({ user: null, signedIn: true }).overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test.each([invoiceDownload, receiptDownload])("rule 5: PDF routes require studio membership and authentication", async (route) => {
    identity(null); expect((await download(route)).status).toBe(401);
    identity("user"); expect((await download(route)).status).toBe(403);
    identity("unexpected-role"); expect((await download(route)).status).toBe(403);
  });
  test("rules 5, 22: another org's invoice/receipt is 404, unpaid receipt 409, paid downloads private PDFs", async () => {
    await db.billingInvoice.create({ data: invoiceData() });
    identity("admin", "other-org");
    expect((await download(invoiceDownload)).status).toBe(404); expect((await download(receiptDownload)).status).toBe(404);
    await expect(invoicePdfFor("other-org", invoiceData().id)).rejects.toMatchObject({ status: 404 });
    await expect(receiptPdfFor("other-org", invoiceData().id)).rejects.toMatchObject({ status: 404 });
    identity("team"); expect((await download(receiptDownload)).status).toBe(409);
    expect((await download(invoiceDownload)).status).toBe(200); // App-rendered invoice needs no Meteroid PDF-ready state.
    await db.billingInvoice.update({ where: { id: invoiceData().id }, data: { status: "paid", paidAt: new Date("2026-11-02"), paymentRefs: ["bank-ref"] } });
    for (const [route, filename] of [[invoiceDownload, "INV-DB-001.pdf"], [receiptDownload, "RCPT-INV-DB-001.pdf"]] as const) {
      const response = await download(route);
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toContain(filename); expect(response.headers.get("cache-control")).toBe("private, no-store");
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      expect(pdf.getProducer()).toBe("TrainerTwin");
      expect(pdf.getAuthor()).toBe(seller.name);
      expect(pdf.getTitle()).toBe(filename.startsWith("RCPT-") ? "Receipt RCPT-INV-DB-001" : "Invoice INV-DB-001");
    }
  });
  test("rule 22: without S3, each download redraws from Meteroid and leaves both PDF keys null", async () => {
    expect(s3Configured).toBe(false);
    await db.billingInvoice.create({ data: { ...invoiceData(), status: "paid", paidAt: new Date("2026-11-02") } });
    const sellerRead = spyOn(billingMeteroid, "sellerDetails").mockResolvedValue(seller);
    try {
      const invoice = await invoicePdfFor(f.org.id, invoiceData().id);
      const receipt = await receiptPdfFor(f.org.id, invoiceData().id);
      sellerRead.mockResolvedValue({ ...seller, name: "Seller changed in Meteroid" });
      const nextInvoice = await invoicePdfFor(f.org.id, invoiceData().id);
      const nextReceipt = await receiptPdfFor(f.org.id, invoiceData().id);
      expect(nextInvoice.equals(invoice)).toBe(false); expect(nextReceipt.equals(receipt)).toBe(false);
      expect((await PDFDocument.load(nextInvoice)).getAuthor()).toBe("Seller changed in Meteroid");
      expect((await PDFDocument.load(nextReceipt)).getAuthor()).toBe("Seller changed in Meteroid");
      expect(sellerRead).toHaveBeenCalledTimes(4);
      expect(await db.billingInvoice.findUniqueOrThrow({ where: { id: invoiceData().id } })).toMatchObject({ invoicePdfKey: null, receiptPdfKey: null });
    } finally { sellerRead.mockRestore(); }
  });
  test.each([404, 503])("rule 22: Meteroid invoice JSON failure %s returns 502 for both PDFs, never PDF-not-ready", async (status) => {
    await db.billingInvoice.create({ data: { ...invoiceData(), status: "paid", paidAt: new Date("2026-11-02") } });
    meteroidServer.use(http.get("https://meteroid.test/api/v1/invoices/:id", () => new HttpResponse(null, { status })));
    for (const route of [invoiceDownload, receiptDownload]) expect((await download(route)).status).toBe(502);
    await expect(invoicePdfFor(f.org.id, invoiceData().id)).rejects.toMatchObject({ name: "BillingError", status: 502 });
    await expect(receiptPdfFor(f.org.id, invoiceData().id)).rejects.toMatchObject({ name: "BillingError", status: 502 });
  });

  test("rule 25: cron GET/POST require secret; local fail-open, production fail-closed", async () => {
    process.env.CRON_SECRET = "cron-test"; process.env.INTERNAL_API_SECRET = "internal-test";
    expect((await cronCheck(new Request("http://dash.test/check"))).status).toBe(401);
    expect((await cronPost(new Request("http://dash.test/check", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    for (const header of [{ authorization: "Bearer cron-test" }, { "x-internal-secret": "cron-test" }]) expect((await cronCheck(new Request("http://dash.test/check", { headers: header }))).status).toBe(200);
    delete process.env.CRON_SECRET;
    expect((await cronPost(new Request("http://dash.test/check", { headers: { "x-internal-secret": "internal-test" } }))).status).toBe(200);
    delete process.env.INTERNAL_API_SECRET; process.env.VERCEL = "1";
    expect((await cronCheck(new Request("http://dash.test/check"))).status).toBe(401);
    delete process.env.VERCEL; expect((await cronCheck(new Request("http://dash.test/check"))).status).toBe(200);
  });

  // Prisma's lazy promise isn't a real Promise to bun's expect().rejects.
  const run = <T>(query: PromiseLike<T>) => Promise.resolve(query);
  test("rules 1, 15: DB plan and pause constraints; default Trial, paused only on Paid", async () => {
    expect(await db.orgBilling.findUniqueOrThrow({ where: { orgId: f.org.id } })).toMatchObject({ plan: "trial", paidSubscriptionId: null, pausedAt: null });
    await expect(run(db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "enterprise" } }))).rejects.toThrow();
    await expect(run(db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: new Date() } }))).rejects.toThrow();
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: `paid-${f.org.id}`, pausedAt: new Date() } });
    expect(await billingOverview(f.org.id)).toMatchObject({ planCents: null, pausedAt: expect.any(String) });
    await expect(run(db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "trial" } }))).rejects.toThrow();
  });
  test.each([{ totalCents: 0 }, { totalCents: -1 }, { kind: "unknown" }, { status: "draft" }, { credits: -1 }, { orgId: "unbilled-org" }])("rule 23 / Checks: DB rejects invalid invoice %j", async (patch) => {
    await expect(run(db.billingInvoice.create({ data: { ...invoiceData(), ...patch } }))).rejects.toThrow();
    expect(await db.billingInvoice.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("invoice positive linked kinds/statuses accepted; deleting billed org cascades invoice", async () => {
    for (const kind of ["upgrade", "renewal", "pack", "other"]) for (const status of ["unpaid", "paid", "void"]) await db.billingInvoice.create({ data: { ...invoiceData(), id: `${invoiceData().id}-${kind}-${status}`, kind, status } });
    expect(await db.billingInvoice.count({ where: { orgId: f.org.id } })).toBe(12);
    await db.orgBilling.delete({ where: { orgId: f.org.id } });
    expect(await db.billingInvoice.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("rule 16: pausedReason uses cached DB; paused org refuses new learners (starting credits) but adds team", async () => {
    expect(await pausedReason("unbilled", "learner")).toBeNull(); expect(await pausedReason(f.org.id, "studio")).toBeNull();
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid", paidSubscriptionId: `paid-${f.org.id}`, pausedAt: new Date() } });
    expect(await pausedReason(f.org.id, "learner")).toContain("ask your trainer"); expect(await pausedReason(f.org.id, "studio")).toContain("Billing page");
    const api = minutesRouter.createCaller({ user: { ...f.trainer, orgId: f.org.id, orgSlug: f.org.slug, role: "admin" } });
    await expect(api.addPeople({ emails: [`new-${f.learner.email}`], role: "user" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("Billing page") });
    expect(await db.member.count({ where: { organizationId: f.org.id, user: { email: `new-${f.learner.email}` } } })).toBe(0);
    expect(await api.addPeople({ emails: [`team-${f.learner.email}`], role: "team" })).toMatchObject({ added: expect.anything() });
    expect(await db.member.count({ where: { organizationId: f.org.id, role: "team", user: { email: `team-${f.learner.email}` } } })).toBe(1);
    expect(await db.minuteLedger.count({ where: { orgId: f.org.id } })).toBe(0);
  });
  test("spec Checks: required release check script exists at web/scripts/check-billing.ts", () => {
    expect(existsSync(new URL("../../scripts/check-billing.ts", import.meta.url))).toBe(true);
  });
  test("spec Checks hold for pending upgrade → Paid → overdue/paused → paid/unpaused → Trial snapshots", async () => {
    const { BILLING_CHECKS } = await import("../../scripts/check-billing");
    const checksHold = async () => {
      // Other parallel tests deliberately break invariants; run the exact checks against this org's snapshot.
      const results = await db.$transaction(async (tx) => {
        for (const table of ["OrgBilling", "BillingInvoice", "BillingPayment"]) {
          await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${table}" ON COMMIT DROP AS SELECT * FROM public."${table}" WHERE "orgId" = $1`, f.org.id);
        }
        const results = [];
        for (const check of BILLING_CHECKS) {
          const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(check.sql);
          results.push({ rule: check.rule, broken: row.n });
        }
        return results;
      });
      expect(results).toHaveLength(8);
      expect(results.filter((result) => result.broken !== 0)).toEqual([]);
    };
    const sub = `paid-${f.org.id}`, issuedEmailAt = new Date("2026-01-01"), paidEmailAt = new Date("2026-01-02");
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { paidSubscriptionId: sub } });
    await db.billingInvoice.create({ data: { ...invoiceData(), kind: "upgrade", subscriptionId: sub, issuedEmailAt } });
    await checksHold();
    await db.billingInvoice.update({ where: { id: invoiceData().id }, data: { status: "paid", paidAt: paidEmailAt, paidEmailAt } });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { plan: "paid" } });
    await checksHold();
    const renewal = `${invoiceData().id}-renewal`;
    await db.billingInvoice.create({ data: { ...invoiceData(), id: renewal, kind: "renewal", subscriptionId: sub, dueDate: new Date("2020-01-01"), issuedEmailAt } });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: new Date() } });
    await checksHold();
    await db.billingInvoice.update({ where: { id: renewal }, data: { status: "paid", paidAt: paidEmailAt, paidEmailAt } });
    await db.orgBilling.update({ where: { orgId: f.org.id }, data: { pausedAt: null } });
    await checksHold();
    await paidSubscriptionEnded(sub); await checksHold();
  });
});
