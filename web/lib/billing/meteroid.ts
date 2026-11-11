import { CREDIT_UNIT, meteroid, MeteroidError } from "@/lib/meteroid";
import { CURRENCY } from "@/lib/billing/pricing";

/**
 * The Meteroid calls billing needs (specs/billing.md), on top of lib/meteroid.ts: customers' billing details, the
 * Paid subscription, invoices and their PDFs, minute packs (top-ups). Two calls exist only in the API Meteroid's
 * dashboard uses (gRPC-web, same API key): voiding an invoice, and marking one paid (scripts and tests only: staff mark
 * invoices paid in Meteroid in phase 2).
 */

/** The plan of every org's Trial subscription (it meters credits; lib/org-billing-setup.ts). Any other subscription is the org's paid plan. */
export const TRIAL_PLAN = "Credits";

const grpcUrl = () => (process.env.METEROID_GRPC_URL?.trim() || "https://meteroid-api.foreverlearning.in").replace(/\/$/, "");

type ProtoField = [number, string | number | boolean | ProtoField[]];

function varint(value: number) {
  const bytes: number[] = [];
  let n = value >>> 0;
  while (n > 127) {
    bytes.push((n & 127) | 128);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

/** Protobuf for the few message shapes used here: strings, ints, bools and nested messages. */
export function encodeProto(fields: ProtoField[]): Buffer {
  return Buffer.concat(fields.map(([field, value]) => {
    if (typeof value === "number" || typeof value === "boolean") return Buffer.concat([varint(field << 3), varint(Number(value))]);
    const bytes = typeof value === "string" ? Buffer.from(value) : encodeProto(value);
    return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
  }));
}

/** Protobuf fields of a message: each field number's values (bytes for strings and messages, numbers for varints). */
export function decodeProto(message: Buffer) {
  const fields = new Map<number, (Buffer | number)[]>();
  let at = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = message[at++];
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
      shift += 7;
    }
  };
  while (at < message.length) {
    const key = varint();
    const [field, wire] = [Math.floor(key / 8), key % 8];
    let value: Buffer | number;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = varint();
      value = message.subarray(at, at + length);
      at += length;
    } else if (wire === 1) { value = Number(message.readBigUInt64LE(at)); at += 8; }
    else if (wire === 5) { value = message.readUInt32LE(at); at += 4; }
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}

/** One gRPC-web call: the reply's message. Throws MeteroidError on a non-zero status. */
export async function meteroidGrpc(service: string, method: string, fields: ProtoField[]): Promise<Buffer> {
  const message = encodeProto(fields);
  const frame = Buffer.alloc(5);
  frame.writeUInt32BE(message.length, 1);
  const key = process.env.METEROID_API_KEY?.trim();
  if (!key) throw new Error("METEROID_API_KEY is not set");
  const response = await fetch(`${grpcUrl()}/${service}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/grpc-web+proto", "x-grpc-web": "1", "x-api-key": key },
    body: Buffer.concat([frame, message]),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = Buffer.from(await response.arrayBuffer());
  const body = reply.toString("latin1");
  const status = response.headers.get("grpc-status") ?? body.match(/grpc-status:\s*(\d+)/)?.[1];
  const detail = decodeURIComponent(response.headers.get("grpc-message") ?? body.match(/grpc-message:\s*([^\r\n]*)/)?.[1] ?? "");
  if (!response.ok || status !== "0") throw new MeteroidError(`Meteroid ${method}: http ${response.status}, grpc ${status ?? "?"} ${detail}`.trim(), response.ok ? 400 : response.status);
  // gRPC-web frames: [flag, 4-byte length, payload]; flag 0 is the message (the trailers frame has the high bit set).
  return reply.length >= 5 && reply[0] === 0 ? reply.subarray(5, 5 + reply.readUInt32BE(1)) : Buffer.alloc(0);
}

/**
 * Us, as on every invoice. `lutArn`: the ARN of the year's LUT (export invoices print it), typed into the invoicing
 * entity's legal footer in Meteroid ("AD330000000000X" or "LUT ARN: AD330000000000X"); "" until it's there.
 */
export type Seller = { name: string; line1: string; line2: string; city: string; zip: string; state: string; country: string; gstin: string; email: string; lutArn: string };

/** The ARN in the legal footer: whatever follows "ARN", or the whole text. */
export const lutArnOf = (footer: string) => (/ARN\s*[:#-]?\s*(\S+)/i.exec(footer)?.[1] ?? footer).trim();

let sellerCache: { at: number; seller: Seller } | null = null;
const SELLER_TTL_MS = 10 * 60_000;

/**
 * Us, as on every invoice and receipt: Meteroid's default invoicing entity (Meteroid › Settings › Invoicing entity),
 * the one place the company's name, address, GSTIN and contact live. Read through the API Meteroid's dashboard uses
 * (no REST endpoint for it); kept for 10 minutes.
 */
/** The tenant's default invoicing entity, as Meteroid has it (its id, and the fields a seller has, maybe empty). */
export async function defaultInvoicingEntity(): Promise<Seller & { id: string }> {
  const reply = decodeProto(await meteroidGrpc("meteroid.api.invoicingentities.v1.InvoicingEntitiesService", "GetInvoicingEntity", []));
  const entity = reply.get(1)?.[0];
  if (!Buffer.isBuffer(entity)) throw new Error("Meteroid returned no invoicing entity");
  const fields = decodeProto(entity);
  const text = (field: number) => {
    const value = fields.get(field)?.[0];
    return Buffer.isBuffer(value) ? value.toString("utf8") : "";
  };
  return { id: text(1), name: text(4), line1: text(14), line2: text(15), zip: text(16), state: text(17), city: text(18), gstin: text(19), country: text(20), email: text(41), lutArn: lutArnOf(text(11)) };
}

export async function sellerDetails(): Promise<Seller> {
  if (sellerCache && Date.now() - sellerCache.at < SELLER_TTL_MS) return sellerCache.seller;
  const entity = await defaultInvoicingEntity();
  const seller: Seller = { name: entity.name, line1: entity.line1, line2: entity.line2, zip: entity.zip, state: entity.state, city: entity.city, gstin: entity.gstin, country: entity.country, email: entity.email, lutArn: entity.lutArn };
  if (!seller.name || !seller.gstin) throw new Error("Meteroid's invoicing entity has no legal name or GSTIN: fill it in (Meteroid › Settings › Invoicing entity)");
  sellerCache = { at: Date.now(), seller };
  return seller;
}

const INVOICES = "meteroid.api.invoices.v1.InvoicesService";

/** Voids an unpaid invoice (an upgrade not paid in time). Meteroid refuses a paid one. */
export const voidInvoice = (invoiceId: string) => meteroidGrpc(INVOICES, "VoidInvoice", [[1, invoiceId]]);

/** Records a payment on the invoice (scripts and tests: staff do this in Meteroid). `amount`: "25.00", the amount due. */
export const markInvoicePaid = (invoiceId: string, amount: string, reference: string) =>
  meteroidGrpc(INVOICES, "MarkInvoiceAsPaid", [[1, invoiceId], [2, amount], [4, reference]]);

export type MeteroidInvoice = {
  id: string;
  number: string;
  status: "DRAFT" | "FINALIZED" | "UNCOLLECTIBLE" | "VOID" | "CLOSED";
  paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "ERRORED" | "PROCESSING";
  type: "RECURRING" | "ONE_OFF" | "ADJUSTMENT" | "USAGE_THRESHOLD";
  customerId: string;
  subscriptionId: string | null;
  totalCents: number;
  taxCents: number;
  currency: string;
  issuedAt: Date;
  dueDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: Date | null;
  paymentRefs: string[];
  /** Credits a minute pack (a credit purchase) adds when paid; 0 for anything else. */
  packCredits: number;
};

/** Meteroid's invoice as its REST API returns it (the fields the app reads). */
export type RawInvoice = Record<string, unknown> & {
  line_items?: { name?: string; description?: string | null; quantity?: string; unit_price?: string; start_date?: string; end_date?: string }[];
  transactions?: { provider_transaction_id?: string | null; status?: string; payment_type?: string; amount?: number; processed_at?: string | null }[];
};

/** Meteroid names a credit purchase's line "Purchase credits" (meteroid-store services/credit/purchase.rs). */
const CREDIT_PURCHASE_LINE = "Purchase credits";

export function toInvoice(raw: RawInvoice): MeteroidInvoice {
  const lines = raw.line_items ?? [];
  const pack = raw.invoice_type === "ONE_OFF" && !raw.subscription_id ? lines.find((line) => line.name === CREDIT_PURCHASE_LINE) : undefined;
  const periodLine = raw.subscription_id ? lines[0] : undefined;
  return {
    id: String(raw.id),
    number: String(raw.invoice_number ?? ""),
    status: raw.status as MeteroidInvoice["status"],
    paymentStatus: (raw.payment_status ?? "UNPAID") as MeteroidInvoice["paymentStatus"],
    type: raw.invoice_type as MeteroidInvoice["type"],
    customerId: String(raw.customer_id),
    subscriptionId: (raw.subscription_id as string | null) ?? null,
    totalCents: Number(raw.total ?? 0),
    taxCents: Number(raw.tax_amount ?? 0),
    currency: String(raw.currency ?? CURRENCY),
    issuedAt: new Date(String(raw.finalized_at ?? raw.created_at)),
    dueDate: String(raw.due_date ?? raw.invoice_date),
    periodStart: periodLine?.start_date ?? null,
    periodEnd: periodLine?.end_date ?? null,
    paidAt: raw.paid_at ? new Date(String(raw.paid_at)) : null,
    paymentRefs: (raw.transactions ?? [])
      .filter((tx) => tx.status === "SETTLED" && tx.payment_type !== "REFUND" && tx.provider_transaction_id)
      .map((tx) => String(tx.provider_transaction_id)),
    packCredits: pack ? Math.round(Number(pack.quantity ?? 0)) : 0,
  };
}

export const getInvoiceRaw = (invoiceId: string) => meteroid<RawInvoice>("GET", `/invoices/${encodeURIComponent(invoiceId)}`);

export async function getInvoice(invoiceId: string) {
  return toInvoice(await getInvoiceRaw(invoiceId));
}

/** The customer's invoices, newest first (one page: enough for a daily check). */
export async function listInvoices(customerId: string, perPage = 50) {
  const page = await meteroid<{ data?: RawInvoice[] }>("GET", `/invoices?customer_id=${encodeURIComponent(customerId)}&order_by=invoice_date.desc&per_page=${perPage}`);
  return (page.data ?? []).map(toInvoice);
}

/** Saves billing details on the customer (lib/billing/details.ts meteroidCustomerPatch). */
export const patchCustomer = (customerId: string, patch: Record<string, unknown>) =>
  meteroid("PATCH", `/customers/${encodeURIComponent(customerId)}`, patch);

export async function getSubscription(subscriptionId: string) {
  const sub = await meteroid<{ id: string; status: string; plan_name: string; customer_id: string }>("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  return { id: sub.id, status: sub.status, planName: sub.plan_name, customerId: sub.customer_id };
}

export const cancelSubscription = (subscriptionId: string, reason: string) =>
  meteroid("POST", `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { effective_date: new Date().toISOString().slice(0, 10), reason });

/** A minute pack: a credit top-up invoiced to the customer; Meteroid grants the credits when it's paid. */
export async function createPackInvoice(input: { customerId: string; credits: number; unitPrice: string; expiresAt: Date; key: string }) {
  const topUp = await meteroid<{ invoice_id?: string | null; status?: string }>("POST", `/customers/${encodeURIComponent(input.customerId)}/top-ups`, {
    amount: input.credits,
    credit_unit: CREDIT_UNIT,
    collection: "SEND_INVOICE",
    unit_price: input.unitPrice,
    expires_at: input.expiresAt.toISOString(),
  }, input.key);
  if (!topUp.invoice_id) throw new Error(`Meteroid made no invoice for the pack (${topUp.status ?? "no status"})`);
  return { invoiceId: topUp.invoice_id };
}
