import { z } from "zod";

/**
 * An org's billing details (specs/billing.md rules 7–9): who the invoices are made out to, where, their tax number,
 * and who receives them; and the tax that follows from the address. Pure: no database, no Meteroid.
 */

/** India's GST state codes (the first two digits of a GSTIN). 25 and 28 are retired codes, not offered. */
export const INDIAN_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

/** Our own state (Forever Learning Solutions, Tamil Nadu): a customer here pays CGST + SGST, elsewhere in India IGST. */
export const HOME_STATE = "33";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
/** Region codes that aren't ISO 3166-1 countries (groupings, reserved and test codes). */
const NOT_COUNTRIES = new Set(["AC", "CP", "DG", "EA", "EU", "EZ", "IC", "QO", "TA", "UN", "XA", "XB", "XK", "ZZ"]);

/** The country's English name, or null when the code isn't a country. */
export function countryName(code: string) {
  if (!/^[A-Z]{2}$/.test(code) || NOT_COUNTRIES.has(code)) return null;
  const name = regionNames.of(code);
  return name && name !== code ? name : null;
}

/** Every country, by name (the Billing tab's list). */
export function countries() {
  const list: { code: string; name: string }[] = [];
  for (let a = 65; a < 91; a++) {
    for (let b = 65; b < 91; b++) {
      const code = String.fromCharCode(a, b);
      const name = countryName(code);
      if (name) list.push({ code, name });
    }
  }
  return list.sort((x, y) => x.name.localeCompare(y.name));
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Whether the GSTIN's last character is its check digit (GSTN's mod-36 scheme): catches most typos. */
export function gstinChecksumOk(gstin: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(gstin[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}

const text = (max: number) => z.string().trim().min(1).max(max);

export const billingDetailsInput = z.object({
  legalName: text(200),
  country: z.string().trim().toUpperCase().refine((code) => countryName(code) !== null, "Choose a country"),
  line1: text(200),
  line2: z.string().trim().max(200).optional().transform((value) => value || undefined),
  city: text(100),
  postalCode: text(20),
  /** India only: the GST state code ("33"). */
  state: z.string().trim().optional().transform((value) => value || undefined),
  /** India: GSTIN (optional, for a registered business). Elsewhere: the local tax number (e.g. a UAE TRN), optional. */
  taxId: z.string().trim().toUpperCase().max(50).optional().transform((value) => value || undefined),
  emails: z.array(z.string().trim().toLowerCase().email().max(320)).min(1, "Add at least one billing email").max(5, "At most 5 billing emails")
    .transform((emails) => [...new Set(emails)]),
  /** With the country code; Razorpay needs it for card payments in USD (specs/billing.md rule 7). */
  phone: z.string().transform((value) => value.replace(/[\s\-().]/g, ""))
    .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Enter the phone number with its country code, like +91 98765 43210")),
}).strict().superRefine((details, ctx) => {
  if (details.country === "IN") {
    if (!details.state || !INDIAN_STATES[details.state]) ctx.addIssue({ code: "custom", path: ["state"], message: "Choose the state" });
    if (details.taxId) {
      if (!GSTIN.test(details.taxId)) ctx.addIssue({ code: "custom", path: ["taxId"], message: "A GSTIN is 15 characters, like 33ABCDE1234F1Z5" });
      else if (!gstinChecksumOk(details.taxId)) ctx.addIssue({ code: "custom", path: ["taxId"], message: "This GSTIN's last character doesn't match: check it for a typo" });
      else if (details.state && details.taxId.slice(0, 2) !== details.state) ctx.addIssue({ code: "custom", path: ["taxId"], message: `This GSTIN is registered in ${INDIAN_STATES[details.taxId.slice(0, 2)] ?? "another state"}, not ${INDIAN_STATES[details.state] ?? "the state chosen"}` });
    }
  } else if (details.state) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "A state is only needed for India" });
  }
});

export type BillingDetails = z.infer<typeof billingDetailsInput>;

export type TaxLine = { code: string; name: string; /** Basis points: 900 = 9%. */ bp: number };
export type Tax = { kind: "cgst_sgst" | "igst" | "export"; lines: TaxLine[] };

/** The tax on this customer's invoices (rule 9). */
export function taxFor(details: Pick<BillingDetails, "country" | "state">): Tax {
  if (details.country !== "IN") return { kind: "export", lines: [] };
  if (details.state === HOME_STATE) return { kind: "cgst_sgst", lines: [{ code: "CGST", name: "CGST", bp: 900 }, { code: "SGST", name: "SGST", bp: 900 }] };
  return { kind: "igst", lines: [{ code: "IGST", name: "IGST", bp: 1800 }] };
}

/** The export wording on invoices to customers outside India; with the LUT reference once there is one. */
export function exportMention(lutReference = process.env.GST_LUT_REFERENCE?.trim()) {
  return `Supply meant for export under LUT${lutReference ? ` (${lutReference})` : ""} without payment of IGST`;
}

/** Meteroid prints no state: for India it goes on the address's second line, with its GST code. */
export function addressLine2(details: Pick<BillingDetails, "country" | "state" | "line2">) {
  const state = details.country === "IN" && details.state ? `${INDIAN_STATES[details.state]} (${details.state})` : undefined;
  return [details.line2, state].filter(Boolean).join(", ") || null;
}

/** The Meteroid customer fields billing details set (PATCH /customers/{id}). */
export function meteroidCustomerPatch(details: BillingDetails) {
  const tax = taxFor(details);
  return {
    name: details.legalName,
    billing_address: {
      line1: details.line1,
      line2: addressLine2(details),
      city: details.city,
      zip_code: details.postalCode,
      state: details.country === "IN" && details.state ? INDIAN_STATES[details.state] : null,
      country: details.country,
    },
    vat_number: details.taxId ?? null,
    phone: details.phone ?? null,
    billing_email: details.emails[0],
    invoicing_emails: details.emails,
    custom_taxes: tax.lines.map((line) => ({ tax_code: line.code, name: line.name, rate: (line.bp / 10_000).toFixed(4) })),
    is_tax_exempt: tax.kind === "export",
    exemption_reason: tax.kind === "export" ? exportMention() : null,
  };
}
