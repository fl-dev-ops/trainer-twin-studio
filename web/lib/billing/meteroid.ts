import { CREDIT_UNIT, meteroid, MeteroidError } from "@/lib/meteroid";
import { CURRENCY } from "@/lib/billing/pricing";

/**
 * The Meteroid calls billing needs (specs/billing.md), on top of lib/meteroid.ts: customers' billing details, the
 * Paid subscription, invoices and their PDFs, minute packs (top-ups). Two calls exist only in the API Meteroid's
 * dashboard uses (gRPC-web, same API key): voiding an invoice, and marking one paid (scripts and tests only: staff mark
 * invoices paid in Meteroid in phase 2).
 */

/** The Meteroid plan a Paid subscription is on (scripts/meteroid-billing-setup.ts creates it). */
export const PAID_PLAN = "Paid";

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

/** One gRPC-web call; throws MeteroidError on a non-zero status. */
export async function meteroidGrpc(service: string, method: string, fields: ProtoField[]) {
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
  const body = Buffer.from(await response.arrayBuffer()).toString("latin1");
  const status = response.headers.get("grpc-status") ?? body.match(/grpc-status:\s*(\d+)/)?.[1];
  const detail = decodeURIComponent(response.headers.get("grpc-message") ?? body.match(/grpc-message:\s*([^\r\n]*)/)?.[1] ?? "");
  if (!response.ok || status !== "0") throw new MeteroidError(`Meteroid ${method}: http ${response.status}, grpc ${status ?? "?"} ${detail}`.trim(), response.ok ? 400 : response.status);
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

type PlanDetails = { id: string; name: string; status: string; currency: string; price_components?: { id: string; name: string }[] };

/** The Paid plan and its one price component. */
export async function paidPlan(): Promise<{ id: string; componentId: string; componentName: string }> {
  const plans = (await meteroid<{ data?: PlanDetails[] }>("GET", "/plans?per_page=100")).data ?? [];
  const summary = plans.find((plan) => plan.name === PAID_PLAN && plan.status === "ACTIVE");
  if (!summary) throw new Error(`Meteroid has no active "${PAID_PLAN}" plan: run scripts/meteroid-billing-setup.ts`);
  const plan = await meteroid<PlanDetails>("GET", `/plans/${summary.id}`);
  const component = plan.price_components?.[0];
  if (!component) throw new Error(`Meteroid's "${PAID_PLAN}" plan has no price`);
  return { id: plan.id, componentId: component.id, componentName: component.name };
}

/** Days an invoice of the Paid plan is due after it's issued (rule 10). */
export const PAID_NET_TERMS = 2;

/**
 * Starts the org's Paid subscription today; Meteroid issues its first invoice at once. `monthlyCents`: a custom
 * price. The key is the org, the day and `attempt` (upgrades cancelled before), so a retry returns the same
 * subscription and an upgrade after a cancelled one gets a new one.
 */
export async function createPaidSubscription(input: { orgId: string; customerId: string; monthlyCents?: number | null; today: string; attempt: number }) {
  const plan = await paidPlan();
  const subscription = await meteroid<{ id?: string; status?: string; subscription?: { id: string; status?: string } }>("POST", "/subscriptions", {
    customer_id_or_alias: input.customerId,
    plan_id: plan.id,
    start_date: input.today,
    activation_condition: "ON_START",
    charge_automatically: false,
    net_terms: PAID_NET_TERMS,
    ...(input.monthlyCents ? {
      price_components: {
        overridden_components: [{
          component_id: plan.componentId,
          name: plan.componentName,
          price_entry: { type: "NEW", cadence: "MONTHLY", currency: CURRENCY, pricing: { type: "RATE", rate: (input.monthlyCents / 100).toFixed(2) } },
        }],
      },
    } : {}),
  }, `paid-subscription-${input.orgId}-${input.today}-${input.attempt}`);
  const id = subscription.id ?? subscription.subscription?.id;
  if (!id) throw new Error(`Meteroid created no subscription for ${input.customerId}`);
  return { id, status: subscription.status ?? subscription.subscription?.status ?? "ACTIVE" };
}

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
