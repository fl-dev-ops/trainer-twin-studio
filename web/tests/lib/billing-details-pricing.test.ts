import { afterEach, describe, expect, test } from "bun:test";
import { addressLine2, billingDetailsInput, countries, countryName, exportMention, gstinChecksumOk, INDIAN_STATES, meteroidCustomerPatch, taxFor } from "@/lib/billing/details";
import { CURRENCY, PACK_CENTS, PACK_CREDITS, PACK_VALID_DAYS, PAID_MONTHLY_CENTS, formatMoney, packPrice, totalWithTax } from "@/lib/billing/pricing";
import { billingEmail } from "@/lib/email";

const details = { legalName: "Example Ltd", country: "IN", line1: "10 Street", city: "Chennai", postalCode: "600001", state: "33", taxId: "33AAGCF6592D1ZN", emails: ["billing@example.com"], phone: "+919876543210" };
const lut = process.env.GST_LUT_REFERENCE;
afterEach(() => { if (lut === undefined) delete process.env.GST_LUT_REFERENCE; else process.env.GST_LUT_REFERENCE = lut; });

function problem(patch: Record<string, unknown>, field: string, message?: string) {
  const parsed = billingDetailsInput.safeParse({ ...details, ...patch });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: [field], ...(message ? { message } : {}) }));
}

describe("billing rules 7–9: details and tax", () => {
  test.each([
    [{ state: undefined }, "state", "Choose the state"],
    [{ state: "25", taxId: undefined }, "state", "Choose the state"],
    [{ country: "US", state: "33", taxId: undefined }, "state", "A state is only needed for India"],
    [{ taxId: "not-gstin" }, "taxId", "A GSTIN is 15 characters, like 33ABCDE1234F1Z5"],
    [{ taxId: "33AAGCF6592D1ZM" }, "taxId", "This GSTIN's last character doesn't match: check it for a typo"],
    [{ state: "29" }, "taxId", "This GSTIN is registered in Tamil Nadu, not Karnataka"],
    [{ emails: [] }, "emails", "Add at least one billing email"],
    [{ emails: Array.from({ length: 6 }, (_, i) => `billing${i}@example.com`) }, "emails", "At most 5 billing emails"],
    [{ country: "EU" }, "country", "Choose a country"],
    [{ country: "ZZ" }, "country", "Choose a country"],
  ] as const)("refuses %j at %s with its field problem", (patch, field, message) => problem(patch, field, message));

  test.each(["legalName", "line1", "city", "postalCode"])("requires %s", (field) => problem({ [field]: "  " }, field));
  test.each([["legalName", 200], ["line1", 200], ["line2", 200], ["city", 100], ["postalCode", 20]] as const)("enforces %s maximum %s", (field, max) => {
    expect(billingDetailsInput.safeParse({ ...details, [field]: "x".repeat(max) }).success).toBe(true);
    problem({ [field]: "x".repeat(max + 1) }, field);
  });
  test("normalizes, deduplicates emails and accepts optional tax IDs and blank second line", () => {
    expect(billingDetailsInput.parse({ ...details, country: " in ", legalName: " Example Ltd ", line2: " ", taxId: " 33aagcf6592d1zn ", emails: [" Billing@EXAMPLE.com ", "billing@example.com"] })).toEqual({ ...details, line2: undefined });
    expect(billingDetailsInput.parse({ ...details, country: "AE", state: "", taxId: "a".repeat(50), emails: Array.from({ length: 5 }, (_, i) => `b${i}@example.com`) }).taxId).toBe("A".repeat(50));
    problem({ country: "AE", state: undefined, taxId: "a".repeat(51) }, "taxId");
    expect(billingDetailsInput.safeParse({ ...details, taxId: undefined }).success).toBe(true);
    const parsed = billingDetailsInput.safeParse({ ...details, emails: ["bad"] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(["emails", 0]);
  });
  test("rule 7: unknown details fields are refused, not silently stripped", () => {
    const parsed = billingDetailsInput.safeParse({ ...details, hacker: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ code: "unrecognized_keys", keys: ["hacker"] }));
  });
  test("GST checksum catches every changed check digit; retired states are absent", () => {
    expect(gstinChecksumOk(details.taxId)).toBe(true);
    for (const char of "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".replace("N", "")) expect(gstinChecksumOk(details.taxId.slice(0, 14) + char)).toBe(false);
    expect(INDIAN_STATES["25"]).toBeUndefined(); expect(INDIAN_STATES["28"]).toBeUndefined();
  });
  test("countries are ISO countries, sorted and unique, not regions or unknown codes", () => {
    const list = countries();
    expect(list).toContainEqual({ code: "IN", name: "India" }); expect(list).toContainEqual({ code: "US", name: "United States" });
    expect(new Set(list.map((c) => c.code)).size).toBe(list.length);
    expect(list.map((c) => c.name)).toEqual(list.map((c) => c.name).sort((a, b) => a.localeCompare(b)));
    for (const code of ["EU", "ZZ", "UN", "XA", "XX", "in", "USA", ""]) expect(countryName(code)).toBeNull();
  });
  test("rule 9: TN has two 9% taxes, other India 18% IGST, exports no tax", () => {
    expect(taxFor(details)).toEqual({ kind: "cgst_sgst", lines: [{ code: "CGST", name: "CGST", bp: 900 }, { code: "SGST", name: "SGST", bp: 900 }] });
    expect(taxFor({ country: "IN", state: "29" })).toEqual({ kind: "igst", lines: [{ code: "IGST", name: "IGST", bp: 1800 }] });
    expect(taxFor({ country: "US" })).toEqual({ kind: "export", lines: [] });
  });
  test("export LUT wording with and without env reference", () => {
    delete process.env.GST_LUT_REFERENCE;
    expect(exportMention()).toBe("Supply meant for export under LUT without payment of IGST");
    process.env.GST_LUT_REFERENCE = " LUT-2026 ";
    expect(exportMention()).toBe("Supply meant for export under LUT (LUT-2026) without payment of IGST");
  });
  test("rule 8: Meteroid patch includes all billing fields and state with code on line2", () => {
    expect(meteroidCustomerPatch({ ...details, line2: "Floor 2" })).toEqual({ name: details.legalName, billing_address: { line1: details.line1, line2: "Floor 2, Tamil Nadu (33)", city: details.city, zip_code: details.postalCode, state: "Tamil Nadu", country: "IN" }, vat_number: details.taxId, phone: details.phone, billing_email: details.emails[0], invoicing_emails: details.emails, custom_taxes: [{ tax_code: "CGST", name: "CGST", rate: "0.0900" }, { tax_code: "SGST", name: "SGST", rate: "0.0900" }], is_tax_exempt: false, exemption_reason: null });
    expect(addressLine2(details)).toBe("Tamil Nadu (33)");
    expect(addressLine2({ country: "US" })).toBeNull();
    expect(addressLine2({ country: "US", line2: "Suite 1" })).toBe("Suite 1");
    expect(meteroidCustomerPatch({ ...details, country: "US", state: undefined, taxId: undefined })).toMatchObject({ vat_number: null, custom_taxes: [], is_tax_exempt: true, exemption_reason: exportMention(), billing_address: { state: null, line2: null } });
    expect(meteroidCustomerPatch({ ...details, state: "29", taxId: undefined }).custom_taxes).toEqual([{ tax_code: "IGST", name: "IGST", rate: "0.1800" }]);
  });
});

describe("billing rules 2 and 4: inclusive USD prices", () => {
  test("plan price includes no credits; pack is 100/$25 valid for 365 days", () => {
    expect([PAID_MONTHLY_CENTS, PACK_CENTS, PACK_CREDITS, PACK_VALID_DAYS, CURRENCY]).toEqual([30000, 2500, 100, 365, "USD"]);
  });
  for (const address of [details, { country: "IN", state: "29" }, { country: "US" }]) {
    const tax = taxFor(address);
    test.each(Array.from({ length: 10 }, (_, i) => i + 1))(`${tax.kind} %s packs: total never exceeds $25/pack, at most one cent short`, (packs) => {
      const price = packPrice(packs, tax.lines);
      expect(price.credits).toBe(packs * 100);
      expect(price.priceCents - price.grossCents).toBeGreaterThanOrEqual(0);
      expect(price.priceCents - price.grossCents).toBeLessThanOrEqual(1);
      expect(Math.round(Number(price.unitPrice) * price.credits * 100)).toBe(price.netCents);
      const meteroidGross = price.netCents + tax.lines.reduce((sum, line) => sum + Math.floor(price.netCents * line.bp / 10000 + 0.5), 0);
      expect(price.grossCents).toBe(meteroidGross);
      expect(price.taxCents).toBe(price.grossCents - price.netCents);
      expect(totalWithTax(price.netCents + 1, tax.lines)).toBeGreaterThan(price.priceCents);
    });
  }
  test("Meteroid rounds each tax separately, half cents upward", () => {
    expect(totalWithTax(50, taxFor(details).lines)).toBe(60);
    expect(totalWithTax(25, taxFor({ country: "IN", state: "29" }).lines)).toBe(30);
  });
  test.each([0, 11, 1.5, -1, NaN, Infinity])("rejects invalid packs %s", (packs) => expect(() => packPrice(packs, [])).toThrow("Buy 1 to 10 packs"));
});

test("formatMoney uses invoice currency and Indian grouping for INR, while default remains USD", () => {
  expect(formatMoney(2500000, "INR")).toBe("₹25,000.00");
  expect(formatMoney(123456789, "INR")).toBe("₹12,34,567.89");
  expect(formatMoney(0, "INR")).toBe("₹0.00");
  expect(formatMoney(30000, "EUR")).toBe("€300.00");
  expect(formatMoney(30000)).toBe("$300.00");
});

test.each(["issued", "reminder", "paused", "upgrade_cancelled", "paid"] as const)("rule 21: %s email escapes billing text and links to billing", (event) => {
  const email = billingEmail({ event, orgName: "<script>org</script>", invoiceNumber: "INV-001", amount: "$300.00", dueDate: "13 Nov 2026", description: "Paid <plan>", billingUrl: "https://dash.test/settings?tab=billing", paymentInstructions: "Bank <acct>\nReference", outcome: "Paid plan active" });
  expect(email.html).not.toContain("<script>org</script>");
  if (event !== "paid") expect(email.html).toContain("&lt;script&gt;org&lt;/script&gt;");
  if (event === "issued" || event === "paid") expect(email.html).toContain("Paid &lt;plan&gt;");
  expect(email.text).toContain("https://dash.test/settings?tab=billing");
  if (event === "paid") expect(email.text).toContain("Paid plan active");
});
