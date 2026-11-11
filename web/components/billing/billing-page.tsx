"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Download, FileCheck2, Minus, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { BillingIcon } from "@/components/icons";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { SupportDialog } from "@/components/support-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, useApi } from "@/lib/api";
import { countries, INDIAN_STATES, type BillingDetails } from "@/lib/billing/details";
import { formatMoney, formatUsd } from "@/lib/billing/pricing";
import { cn } from "@/lib/utils";

/**
 * Billing (specs/billing.md), for admin and team: the plan and its status, minute packs (Paid plan), every invoice with
 * its PDF and, once paid, its receipt, and the billing details on them. Credits and where they went are on Usage.
 */

type Overview = Awaited<ReturnType<typeof api.billing.overview.query>>;
type Billed = Extract<Overview, { billed: true }>;
type Invoice = Billed["invoices"][number];

const QUERY = ["billing.overview"];
const CARD = "rounded-tt-lg border border-(--card-border) bg-card shadow-card";
const INVOICES_SHOWN = 5;
/** Fixed columns (description, date, status, amount, actions), so rows line up with or without Pay now. */
const INVOICE_GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 sm:grid-cols-[minmax(0,1fr)_96px_104px_80px_128px]";
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dayMonth = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const STATUS: Record<Invoice["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  paid: { label: "Paid", variant: "secondary" },
  unpaid: { label: "Due", variant: "outline" },
  overdue: { label: "Overdue", variant: "destructive" },
  void: { label: "Cancelled", variant: "outline" },
};

/**
 * Downloads a PDF with fetch, not a plain link, so the request carries this tab's org (components/org-pin.tsx): someone
 * in several orgs gets this org's invoice even after switching org in another tab.
 */
async function download(href: string, filename: string) {
  const response = await fetch(href);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    toast.error(body?.error ?? "Could not download it; please try again.");
    return;
  }
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

const message = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong; please try again.");

/** Razorpay's page for an invoice: in this tab, so the payer comes back here (Razorpay's callback). */
function PayNow({ url, label = "Pay now" }: { url: string; label?: string }) {
  return <Button variant="brand" size="sm" onClick={() => window.location.assign(url)}>{label}</Button>;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="m-0 text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A row of a section's card: the label and its detail on the left, an action or value on the right. */
function Row({ title, detail, children }: { title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-(--border) px-5 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {detail ? <div className="mt-0.5 text-sm text-muted-foreground">{detail}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * Back from Razorpay (`?paid=INV-…`): the payment reaches us by webhook within seconds, so the page checks again
 * every 3 s for up to 2 minutes and says when it has arrived.
 */
function PaymentArriving({ invoices }: { invoices: Invoice[] }) {
  const params = useSearchParams();
  const number = params.get("paid");
  const linkId = params.get("razorpay_payment_link_id");
  const queryClient = useQueryClient();
  const [gaveUp, setGaveUp] = useState(false);
  const paid = invoices.find((invoice) => invoice.number === number)?.status === "paid";
  // Ask Razorpay now rather than wait for its webhook (the server checks with Razorpay, not this URL).
  useEffect(() => {
    if (!linkId) return;
    void api.billing.confirmPayment.mutate({ paymentLinkId: linkId })
      .then(() => queryClient.invalidateQueries({ queryKey: QUERY }))
      .catch(() => undefined);
  }, [linkId, queryClient]);
  useEffect(() => {
    if (!number || paid) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > 120_000) {
        setGaveUp(true);
        window.clearInterval(timer);
      } else void queryClient.invalidateQueries({ queryKey: QUERY });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [number, paid, queryClient]);
  if (!number) return null;
  return (
    <Alert>
      <AlertTitle>{paid ? "Payment received, thank you" : "Confirming your payment…"}</AlertTitle>
      <AlertDescription>
        {paid
          ? `Invoice ${number} is paid. Your receipt is on its way by email and below.`
          : gaveUp
            ? `It's taking longer than usual. If you paid, invoice ${number} will show as paid shortly and you'll get a receipt by email.`
            : `We're waiting for Razorpay to confirm invoice ${number}. This usually takes a few seconds.`}
      </AlertDescription>
    </Alert>
  );
}

export function BillingPage() {
  const overview = useApi(QUERY, () => api.billing.overview.query());
  return (
    <PageContainer className="max-w-3xl">
      <PageHeader icon={BillingIcon} title="Billing" description="Your plan, minute packs, invoices and billing details." />
      <div className="mt-8 flex flex-col gap-10">
        {overview.billed ? (
          <>
            <PaymentArriving invoices={overview.invoices} />
            <PlanSection overview={overview} />
            <AddOnsSection overview={overview} />
            <InvoicesSection invoices={overview.invoices} />
            <DetailsSection details={overview.details} />
          </>
        ) : (
          <div className={cn(CARD, "px-5 py-6 text-sm text-muted-foreground")}>Billing isn&apos;t set up for this organization yet. Contact TrainerTwin.</div>
        )}
      </div>
    </PageContainer>
  );
}

function PlanSection({ overview }: { overview: Billed }) {
  // The Support dialog, blank or pre-filled to ask for an upgrade (staff move orgs to a paid plan; specs/billing.md rule 10).
  const [support, setSupport] = useState<string | null>(null);
  const paused = Boolean(overview.pausedAt);
  const paid = overview.plan === "paid";
  const price = overview.planCents ? `${formatUsd(overview.planCents)} / month, tax included` : "Your paid plan";
  return (
    <Section title="Plan">
      <div className={CARD}>
        <Row
          title={(
            <span className="flex items-center gap-2">
              {paid ? "Paid plan" : "Trial plan"}
              {paused ? <Badge variant="destructive">Paused</Badge> : overview.upgradePending ? <Badge variant="outline">Upgrade waiting for payment</Badge> : <Badge variant="secondary">Active</Badge>}
            </span>
          )}
          detail={paid ? `${price}${overview.renewsOn ? ` · renews ${day(overview.renewsOn)}` : ""}` : "Free, with no expiry. Credits come from minute packs and grants."}
        >
          <Button variant="outline" size="sm" onClick={() => setSupport("")}>Support</Button>
          {paid ? null : <Button variant="brand" size="sm" onClick={() => setSupport("Upgrade to a paid plan")}>Request upgrade</Button>}
        </Row>
        {paused && overview.overdueInvoice ? (
          <div className="border-t border-(--border) p-5">
            <Alert variant="destructive">
              <AlertTitle>Your plan is paused</AlertTitle>
              <AlertDescription>
                Invoice {overview.overdueInvoice.number} ({formatMoney(overview.overdueInvoice.totalCents, overview.overdueInvoice.currency)}) was due {day(overview.overdueInvoice.dueDate)}. No new calls can start and no credits can be given until your overdue invoices are paid. {overview.overdueInvoice.payUrl ? "" : "Add a phone number to your billing details to pay online, or reply to the invoice email. "}Already paid? Reply to the invoice email.
                {overview.overdueInvoice.payUrl ? <div className="mt-3"><PayNow url={overview.overdueInvoice.payUrl} /></div> : null}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        {overview.upgradeInvoice ? (
          <div className="border-t border-(--border) p-5">
            <Alert>
              <AlertTitle>Upgrade waiting for payment</AlertTitle>
              <AlertDescription>
                Invoice {overview.upgradeInvoice.number} ({formatMoney(overview.upgradeInvoice.totalCents, overview.upgradeInvoice.currency)}) is due {day(overview.upgradeInvoice.dueDate)}. You move to the Paid plan as soon as it&apos;s paid; unpaid by then, the upgrade is cancelled and you stay on Trial.{overview.upgradeInvoice.payUrl ? "" : " Add a phone number to your billing details to pay online, or reply to the invoice email."}
                {overview.upgradeInvoice.payUrl ? <div className="mt-3"><PayNow url={overview.upgradeInvoice.payUrl} /></div> : null}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        {paid && !paused && overview.dueInvoice ? (
          <Row title={`Invoice ${overview.dueInvoice.number} is due ${day(overview.dueInvoice.dueDate)}`} detail="Unpaid by then, the plan is paused.">
            <span className="text-sm tabular-nums">{formatMoney(overview.dueInvoice.totalCents, overview.dueInvoice.currency)}</span>
            {overview.dueInvoice.payUrl ? <PayNow url={overview.dueInvoice.payUrl} /> : null}
          </Row>
        ) : null}
      </div>
      {/* Remounted per opening, so it starts from its subject. */}
      {support !== null ? <SupportDialog key={support} open onOpenChange={(open) => { if (!open) setSupport(null); }} subject={support} /> : null}
    </Section>
  );
}

function AddOnsSection({ overview }: { overview: Billed }) {
  const [open, setOpen] = useState(false);
  const paused = Boolean(overview.pausedAt);
  // Why a pack can't be bought now (specs/billing.md rules 6 and 19), or null.
  const blocked = overview.plan !== "paid"
    ? "Available on the Paid plan."
    : paused
      ? "Pay the overdue invoice first."
      : !overview.details
        ? "Add your billing details first."
        : null;
  return (
    <Section title="Add-ons">
      <div className={CARD}>
        <Row
          title="Minute packs"
          detail={blocked ?? `${overview.pack.credits} credits for ${formatUsd(overview.pack.cents)}, tax included. Added when the invoice is paid; they expire a year later.`}
        >
          <Button variant="ghost" size="sm" render={<Link href="/usage" />}>See usage</Button>
          <Button variant="brand" size="sm" disabled={Boolean(blocked)} onClick={() => setOpen(true)}>Buy credits</Button>
        </Row>
      </div>
      <BuyPacksDialog overview={overview} open={open} onOpenChange={setOpen} />
    </Section>
  );
}

function BuyPacksDialog({ overview, open, onOpenChange }: { overview: Billed; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [packs, setPacks] = useState(1);
  // One purchase per choice: a click retried after a timeout reuses it (the server makes one invoice per id).
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const choose = (count: number) => {
    setPacks(Math.min(overview.pack.maxPacks, Math.max(1, count)));
    setRequestId(crypto.randomUUID());
  };
  async function buy() {
    setBusy(true);
    try {
      const result = await api.billing.buyPacks.mutate({ packs, requestId });
      setRequestId(crypto.randomUUID());
      if (result.payUrl) return window.location.assign(result.payUrl);
      toast.success(`Invoice ${result.number ?? ""} is on its way by email. The credits are added once it's paid.`.replace("  ", " "));
      await queryClient.invalidateQueries({ queryKey: QUERY });
      onOpenChange(false);
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Buy credits</DialogTitle>
          <DialogDescription>{overview.pack.credits} credits a pack, {formatUsd(overview.pack.cents)} each, tax included. 1 credit = 1 minute of practice.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon-sm" aria-label="One pack less" disabled={packs <= 1} onClick={() => choose(packs - 1)}><Minus /></Button>
            <span className="w-16 text-center text-sm tabular-nums" aria-live="polite">{packs} {packs === 1 ? "pack" : "packs"}</span>
            <Button variant="outline" size="icon-sm" aria-label="One pack more" disabled={packs >= overview.pack.maxPacks} onClick={() => choose(packs + 1)}><Plus /></Button>
          </div>
          <div className="text-right">
            <p className="m-0 text-sm font-medium tabular-nums">{(packs * overview.pack.credits).toLocaleString()} credits</p>
            <p className="m-0 text-sm text-muted-foreground tabular-nums">{formatUsd(packs * overview.pack.cents)}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="brand" disabled={busy} onClick={() => void buy()}>{busy ? "Creating invoice…" : "Continue to pay"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InvoicesSection({ invoices }: { invoices: Invoice[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? invoices : invoices.slice(0, INVOICES_SHOWN);
  return (
    <Section
      title="Invoices"
      action={invoices.length > INVOICES_SHOWN ? <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>{all ? "Show fewer" : "View all"}</Button> : null}
    >
      <div className={CARD}>
        {shown.length ? shown.map((invoice) => (
          <div key={invoice.id} className={cn(INVOICE_GRID, "border-t border-(--border) px-5 py-3 text-sm first:border-t-0")}>
            <div className="min-w-0">
              <p className="m-0 truncate font-medium">{invoice.description}</p>
              <p className="m-0 truncate text-xs text-muted-foreground">{invoice.number}</p>
            </div>
            <span className="hidden text-muted-foreground tabular-nums sm:block">{day(invoice.issuedAt)}</span>
            <span className="hidden sm:block">
              <Badge variant={STATUS[invoice.status].variant}>{STATUS[invoice.status].label}</Badge>
              {invoice.status === "unpaid" || invoice.status === "overdue" ? <span className="block text-xs text-muted-foreground">due {dayMonth(invoice.dueDate)}</span> : null}
            </span>
            <span className="hidden text-right tabular-nums sm:block">{formatMoney(invoice.totalCents, invoice.currency)}</span>
            <span className="flex items-center justify-end gap-1">
              {invoice.payUrl && (invoice.status === "unpaid" || invoice.status === "overdue") ? <PayNow url={invoice.payUrl} /> : null}
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="subtle" size="icon-sm" aria-label={`Downloads for ${invoice.number}`} />}>
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void download(`/api/billing/invoices/${invoice.id}/pdf`, `${invoice.number}.pdf`)}>
                    <Download /> Download invoice
                  </DropdownMenuItem>
                  {invoice.status === "paid" ? (
                    <DropdownMenuItem onClick={() => void download(`/api/billing/invoices/${invoice.id}/receipt`, `RCPT-${invoice.number}.pdf`)}>
                      <FileCheck2 /> Download receipt
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
        )) : <p className="m-0 px-5 py-6 text-center text-sm text-muted-foreground">No invoices yet.</p>}
      </div>
      <p className="m-0 text-xs text-muted-foreground">Invoices and receipts are emailed to your billing emails. Pay online with Pay now (card, or bank transfer where offered).</p>
    </Section>
  );
}

function DetailsSection({ details }: { details: BillingDetails | null }) {
  const [editing, setEditing] = useState(false);
  const countryList = useMemo(() => countries(), []);
  const address = details
    ? [details.line1, details.line2, [details.postalCode, details.city].join(" "), details.country === "IN" && details.state ? `${INDIAN_STATES[details.state]} (${details.state})` : null, countryList.find((c) => c.code === details.country)?.name].filter(Boolean)
    : [];
  return (
    <Section title="Billing information" action={<Button variant="ghost" size="sm" onClick={() => setEditing(true)}>{details ? "Edit" : "Add"}</Button>}>
      <div className={CARD}>
        {details ? (
          <>
            <Row title="Billing emails" detail={details.emails.join(", ")} />
            <Row title="Legal name" detail={details.legalName} />
            <Row title="Billing address" detail={address.map((line) => <span key={line} className="block">{line}</span>)} />
            {details.taxId ? <Row title={details.country === "IN" ? "GSTIN" : "Tax number"} detail={details.taxId} /> : null}
            <Row title="Phone" detail={details.phone || <span className="text-destructive">Add a phone number to pay online.</span>} />
          </>
        ) : (
          <Row title="No billing details yet" detail="They go on every invoice, and you need them to buy minute packs." >
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Add billing details</Button>
          </Row>
        )}
      </div>
      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md!">
          <SheetHeader>
            <SheetTitle>Billing information</SheetTitle>
            <SheetDescription>Who invoices are made out to. For India, the state decides the GST (Tamil Nadu: CGST + SGST; other states: IGST); outside India, no Indian GST.</SheetDescription>
          </SheetHeader>
          {/* Remounted each time it opens, so it starts from what's saved. */}
          {editing ? <DetailsForm details={details} onDone={() => setEditing(false)} /> : null}
        </SheetContent>
      </Sheet>
    </Section>
  );
}

const EMPTY: BillingDetails = { legalName: "", country: "IN", line1: "", line2: undefined, city: "", postalCode: "", state: undefined, taxId: undefined, emails: [], phone: "" };
const FIELDS = ["legalName", "country", "line1", "city", "postalCode", "state", "taxId", "emails", "phone"];

function DetailsForm({ details, onDone }: { details: BillingDetails | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  // Details saved before the phone was asked for have none: the form asks for it.
  const [form, setForm] = useState<BillingDetails>(details ? { ...details, phone: details.phone ?? "" } : EMPTY);
  const [emails, setEmails] = useState((details?.emails ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: string; text: string } | null>(null);
  const countryList = useMemo(() => countries(), []);
  const india = form.country === "IN";
  const set = (key: keyof BillingDetails) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const list = emails.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
      await api.billing.saveDetails.mutate({ details: { ...form, state: india ? form.state : undefined, emails: list } });
      toast.success("Billing details saved");
      await queryClient.invalidateQueries({ queryKey: QUERY });
      onDone();
    } catch (failure) {
      const text = message(failure);
      const field = /^([a-zA-Z]+)(\.\d+)?: /.exec(text)?.[1] ?? "form";
      setError({ field, text: text.replace(/^[a-zA-Z]+(\.\d+)?: /, "") });
    } finally {
      setBusy(false);
    }
  }

  const invalid = (field: string) => error?.field === field;
  return (
    <form onSubmit={save} className="flex flex-col gap-5 px-4 pb-4">
      <FieldGroup>
        <Field data-invalid={invalid("legalName")}>
          <FieldLabel htmlFor="billing-name">Legal name</FieldLabel>
          <Input id="billing-name" value={form.legalName} onChange={set("legalName")} maxLength={200} required />
          {invalid("legalName") ? <FieldError>{error?.text}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid("country")}>
          <FieldLabel htmlFor="billing-country">Country</FieldLabel>
          <NativeSelect id="billing-country" value={form.country} onChange={set("country")} className="w-full">
            {countryList.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
          </NativeSelect>
          {invalid("country") ? <FieldError>{error?.text}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid("line1")}>
          <FieldLabel htmlFor="billing-line1">Address</FieldLabel>
          <Input id="billing-line1" value={form.line1} onChange={set("line1")} maxLength={200} required placeholder="Street and number" />
          <Input aria-label="Address line 2" value={form.line2 ?? ""} onChange={set("line2")} maxLength={200} placeholder="Area, building (optional)" />
          {invalid("line1") ? <FieldError>{error?.text}</FieldError> : null}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={invalid("city")}>
            <FieldLabel htmlFor="billing-city">City</FieldLabel>
            <Input id="billing-city" value={form.city} onChange={set("city")} maxLength={100} required />
            {invalid("city") ? <FieldError>{error?.text}</FieldError> : null}
          </Field>
          <Field data-invalid={invalid("postalCode")}>
            <FieldLabel htmlFor="billing-postal">Postal code</FieldLabel>
            <Input id="billing-postal" value={form.postalCode} onChange={set("postalCode")} maxLength={20} required />
            {invalid("postalCode") ? <FieldError>{error?.text}</FieldError> : null}
          </Field>
        </div>
        {india ? (
          <Field data-invalid={invalid("state")}>
            <FieldLabel htmlFor="billing-state">State</FieldLabel>
            <NativeSelect id="billing-state" value={form.state ?? ""} onChange={set("state")} className="w-full" required>
              <option value="" disabled>Choose the state</option>
              {Object.entries(INDIAN_STATES).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
            </NativeSelect>
            {invalid("state") ? <FieldError>{error?.text}</FieldError> : null}
          </Field>
        ) : null}
        <Field data-invalid={invalid("taxId")}>
          <FieldLabel htmlFor="billing-tax">{india ? "GSTIN (optional)" : "Tax number (optional)"}</FieldLabel>
          <Input id="billing-tax" value={form.taxId ?? ""} onChange={set("taxId")} maxLength={50} placeholder={india ? "33ABCDE1234F1Z5" : "e.g. VAT or TRN number"} />
          {invalid("taxId") ? <FieldError>{error?.text}</FieldError> : null}
        </Field>
        <Field data-invalid={invalid("emails")}>
          <FieldLabel htmlFor="billing-emails">Billing emails</FieldLabel>
          <Input id="billing-emails" value={emails} onChange={(event) => setEmails(event.target.value)} placeholder="accounts@company.com, you@company.com" required />
          {invalid("emails") ? <FieldError>{error?.text}</FieldError> : <p className="text-xs text-muted-foreground">Up to 5, separated by commas. Invoices and receipts go here.</p>}
        </Field>
        <Field data-invalid={invalid("phone")}>
          <FieldLabel htmlFor="billing-phone">Phone</FieldLabel>
          <Input id="billing-phone" type="tel" value={form.phone ?? ""} onChange={set("phone")} placeholder="+91 98765 43210" required />
          {invalid("phone") ? <FieldError>{error?.text}</FieldError> : <p className="text-xs text-muted-foreground">With the country code. Needed to pay online by card.</p>}
        </Field>
      </FieldGroup>
      {error && !FIELDS.includes(error.field) ? <p role="alert" className="text-sm text-destructive">{error.text}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save billing details"}</Button>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
