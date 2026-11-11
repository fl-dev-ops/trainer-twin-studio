"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Download, FileCheck2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, useApi } from "@/lib/api";
import { countries, INDIAN_STATES, type BillingDetails } from "@/lib/billing/details";
import { formatMoney, formatUsd } from "@/lib/billing/pricing";

/**
 * Settings › Billing (specs/billing.md), for admin and team: the plan and its status, billing details (needed before
 * upgrading or buying), minute packs (Paid plan), and every invoice with its PDF and, once paid, its receipt.
 */

type Overview = Awaited<ReturnType<typeof api.billing.overview.query>>;
type Billed = Extract<Overview, { billed: true }>;
type Invoice = Billed["invoices"][number];

const QUERY = ["billing.overview"];
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

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

export function BillingSection() {
  const overview = useApi(QUERY, () => api.billing.overview.query());
  if (!overview.billed) {
    return (
      <Card className="mt-3">
        <CardContent><p className="text-sm text-muted-foreground">Billing isn&apos;t set up for this organization yet. Contact TrainerTwin.</p></CardContent>
      </Card>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-6">
      <PaymentArriving invoices={overview.invoices} />
      <PlanCard overview={overview} />
      <DetailsCard details={overview.details} />
      {overview.plan === "paid" ? <PacksCard overview={overview} /> : null}
      <InvoicesCard invoices={overview.invoices} />
    </div>
  );
}

function PlanCard({ overview }: { overview: Billed }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const paused = Boolean(overview.pausedAt);
  async function upgrade() {
    setBusy(true);
    try {
      const result = await api.billing.upgrade.mutate();
      if (result.payUrl) return window.location.assign(result.payUrl);
      toast.success("Upgrade started: your invoice is on its way by email.");
      await queryClient.invalidateQueries({ queryKey: QUERY });
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  }
  const price = `${formatUsd(overview.monthlyCents)} a month, tax included`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {overview.plan === "paid" ? "Paid plan" : "Trial plan"}
          {paused ? <Badge variant="destructive">Paused</Badge> : overview.upgradePending ? <Badge variant="outline">Upgrade waiting for payment</Badge> : <Badge variant="secondary">Active</Badge>}
        </CardTitle>
        <CardDescription>
          {overview.plan === "paid"
            ? `${price}${overview.renewsOn ? `, renews ${day(overview.renewsOn)}` : ""}. Credits come from minute packs and grants.`
            : "Free, with no expiry. Upgrade to the Paid plan to buy minute packs."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {paused && overview.overdueInvoice ? (
          <Alert variant="destructive">
            <AlertTitle>Your plan is paused</AlertTitle>
            <AlertDescription>
              Invoice {overview.overdueInvoice.number} ({formatMoney(overview.overdueInvoice.totalCents, overview.overdueInvoice.currency)}) was due {day(overview.overdueInvoice.dueDate)}. No new calls can start and no credits can be given until your overdue invoices are paid. {overview.overdueInvoice.payUrl ? "" : "Pay by bank transfer using the details on the invoice, quoting its number. "}Already paid? Reply to the invoice email.
              {overview.overdueInvoice.payUrl ? <div className="mt-3"><PayNow url={overview.overdueInvoice.payUrl} /></div> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {overview.upgradeInvoice ? (
          <Alert>
            <AlertTitle>Upgrade waiting for payment</AlertTitle>
            <AlertDescription>
              Invoice {overview.upgradeInvoice.number} ({formatMoney(overview.upgradeInvoice.totalCents, overview.upgradeInvoice.currency)}) is due {day(overview.upgradeInvoice.dueDate)}. You move to the Paid plan as soon as it&apos;s paid; unpaid by then, the upgrade is cancelled and you stay on Trial.{overview.upgradeInvoice.payUrl ? "" : " Pay by bank transfer using the details on the invoice, quoting its number."}
              {overview.upgradeInvoice.payUrl ? <div className="mt-3"><PayNow url={overview.upgradeInvoice.payUrl} /></div> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {overview.plan === "trial" && !overview.upgradePending ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              <span className="font-medium">Paid plan:</span> {price}. You get an invoice now and move to Paid once it&apos;s paid.
            </p>
            <Button variant="brand" onClick={upgrade} disabled={busy || !overview.details} title={overview.details ? undefined : "Add billing details first"}>
              {busy ? "Starting…" : "Upgrade to Paid"}
            </Button>
          </div>
        ) : null}
        {overview.plan === "trial" && !overview.details ? (
          <p className="text-sm text-muted-foreground">Add your billing details below first: they go on the invoice.</p>
        ) : null}
        {overview.plan === "paid" && !paused && overview.dueInvoice ? (
          <p className="text-sm text-muted-foreground">
            Invoice {overview.dueInvoice.number} ({formatMoney(overview.dueInvoice.totalCents, overview.dueInvoice.currency)}) is due {day(overview.dueInvoice.dueDate)}. Unpaid by then, the plan is paused.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const EMPTY: BillingDetails = { legalName: "", country: "IN", line1: "", line2: undefined, city: "", postalCode: "", state: undefined, taxId: undefined, emails: [], phone: "" };

function DetailsCard({ details }: { details: BillingDetails | null }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(!details);
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
      setEditing(false);
    } catch (failure) {
      const text = message(failure);
      const field = /^([a-zA-Z]+)(\.\d+)?: /.exec(text)?.[1] ?? "form";
      setError({ field, text: text.replace(/^[a-zA-Z]+(\.\d+)?: /, "") });
    } finally {
      setBusy(false);
    }
  }

  if (!editing && details) {
    const lines = [details.line1, details.line2, [details.postalCode, details.city].join(" "), india && details.state ? `${INDIAN_STATES[details.state]} (${details.state})` : null, countryList.find((c) => c.code === details.country)?.name].filter(Boolean);
    return (
      <Card>
        <CardHeader>
          <CardTitle>Billing details</CardTitle>
          <CardDescription>On every invoice. Invoices and receipts are emailed to the billing emails.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:justify-between">
          <div className="text-sm">
            <p className="font-medium">{details.legalName}</p>
            {lines.map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
            {details.taxId ? <p className="text-muted-foreground">{details.country === "IN" ? "GSTIN" : "Tax number"}: {details.taxId}</p> : null}
            <p className="mt-2">Billing emails: {details.emails.join(", ")}</p>
            {details.phone ? <p>Phone: {details.phone}</p> : <p className="text-destructive">Add a phone number to pay online.</p>}
          </div>
          <div><Button variant="outline" onClick={() => setEditing(true)}>Edit</Button></div>
        </CardContent>
      </Card>
    );
  }

  const invalid = (field: string) => error?.field === field;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing details</CardTitle>
        <CardDescription>Who invoices are made out to. For India, the state decides the GST (Tamil Nadu: CGST + SGST; other states: IGST); outside India, no Indian GST.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-5">
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
          {error?.field === "form" || (error && !["legalName", "country", "line1", "city", "postalCode", "state", "taxId", "emails", "phone"].includes(error.field)) ? (
            <p role="alert" className="text-sm text-destructive">{error.text}</p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save billing details"}</Button>
            {details ? <Button type="button" variant="outline" onClick={() => { setForm({ ...details, phone: details.phone ?? "" }); setEmails(details.emails.join(", ")); setError(null); setEditing(false); }}>Cancel</Button> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PacksCard({ overview }: { overview: Billed }) {
  const queryClient = useQueryClient();
  const [packs, setPacks] = useState(1);
  // One purchase per choice: a click retried after a timeout reuses it (the server makes one invoice per id).
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const paused = Boolean(overview.pausedAt);
  async function buy() {
    setBusy(true);
    try {
      const result = await api.billing.buyPacks.mutate({ packs, requestId });
      setRequestId(crypto.randomUUID());
      if (result.payUrl) return window.location.assign(result.payUrl);
      toast.success(`Invoice ${result.number ?? ""} is on its way by email. The credits are added once it's paid.`.replace("  ", " "));
      await queryClient.invalidateQueries({ queryKey: QUERY });
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Minute packs</CardTitle>
        <CardDescription>
          {overview.pack.credits} credits for {formatUsd(overview.pack.cents)}, tax included (1 credit = 1 minute of practice). Credits are added as soon as the invoice is paid and expire a year after the invoice date.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <NativeSelect aria-label="Packs" value={String(packs)} onChange={(event) => { setPacks(Number(event.target.value)); setRequestId(crypto.randomUUID()); }} disabled={paused}>
          {Array.from({ length: overview.pack.maxPacks }, (_, index) => index + 1).map((count) => (
            <option key={count} value={count}>{count} × {overview.pack.credits} credits: {formatUsd(count * overview.pack.cents)}</option>
          ))}
        </NativeSelect>
        <Button variant="brand" onClick={buy} disabled={busy || paused || !overview.details}>{busy ? "Creating invoice…" : `Buy ${packs * overview.pack.credits} credits`}</Button>
        {paused ? <p className="text-sm text-muted-foreground">Pay the overdue invoice first.</p> : null}
      </CardContent>
    </Card>
  );
}

function InvoicesCard({ invoices }: { invoices: Invoice[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
        <CardDescription>Pay online with Pay now, or by bank transfer using the details on the invoice (quote its number). Paid invoices have a receipt.</CardDescription>
      </CardHeader>
      <CardContent>
        {invoices.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>For</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Download</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="font-medium">{invoice.number}</TableCell>
                  <TableCell>{day(invoice.issuedAt)}</TableCell>
                  <TableCell>{invoice.description}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(invoice.totalCents, invoice.currency)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS[invoice.status].variant}>{STATUS[invoice.status].label}</Badge>
                    {invoice.status === "unpaid" || invoice.status === "overdue" ? <span className="ml-2 text-xs text-muted-foreground">due {day(invoice.dueDate)}</span> : null}
                    {invoice.paidAt ? <span className="ml-2 text-xs text-muted-foreground">{day(invoice.paidAt)}</span> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {invoice.payUrl && (invoice.status === "unpaid" || invoice.status === "overdue") ? <PayNow url={invoice.payUrl} /> : null}
                      <Button size="sm" variant="ghost" onClick={() => download(`/api/billing/invoices/${invoice.id}/pdf`, `${invoice.number}.pdf`)} aria-label={`Download invoice ${invoice.number}`}>
                        <Download data-icon="inline-start" /> Invoice
                      </Button>
                      {invoice.status === "paid" ? (
                        <Button size="sm" variant="ghost" onClick={() => download(`/api/billing/invoices/${invoice.id}/receipt`, `RCPT-${invoice.number}.pdf`)} aria-label={`Download receipt for ${invoice.number}`}>
                          <FileCheck2 data-icon="inline-start" /> Receipt
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
