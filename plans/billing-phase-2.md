# Billing phase 2: plans, invoices and minute packs (payments by hand)

Status: **built 11 Nov 2026 on branch `billing-phase-2`** (rule spec `specs/billing.md`, release runbook
`plans/billing-phase-2-release.md`); decisions agreed 11 Nov 2026, with the changes the build found below. Phase 1 (org credits in Meteroid) is live
(`plans/phase1-release.md`). Phase 3 (Razorpay collects the money) follows: `plans/billing-phase-3.md`.

**Goal:** every org is on a plan in Meteroid; an org pays to move to the Paid plan and to buy minute packs; Meteroid
issues every invoice; the app emails each invoice and its paid copy, and pauses an org whose renewal goes unpaid.
Payments are recorded **by hand** (e.g. a bank transfer) until phase 3.

Before code, these rules become a rule spec, `specs/billing.md`, for review (the way `specs/people.md` came first for
the people work). Code, tests and module specs follow it.

## Decisions (11 Nov 2026)

| # | Decision |
| --- | --- |
| 1 | **Seller:** Forever Learning Solutions Pvt Ltd, **GSTIN 33AAGCF6592D1ZN** (33 = Tamil Nadu), No. 52/2A1 School Street, Right side, Selaiyur, Rajakilpakkam, Kanchipuram, Tambaram, Tamil Nadu 600073. |
| 2 | **LUT** (for customers abroad, e.g. Olga): to be confirmed by you / your accountant. The invoice gets a LUT reference field now; the number is filled in when confirmed. |
| 3 | **Every org starts on the Trial plan** ($0, no expiry for now), Olga too. An org moves to the **Paid plan only after it has paid** its first Paid invoice. |
| 4 | **No plan includes credits.** Credits come only from **minute packs** and **grants** (as in phase 1). |
| 5 | **Minute packs:** add-on packs, **100 credits for $25, tax included**. **Paid orgs only** (Trial orgs can't buy them, for now). |
| 6 | **The Paid plan:** $300 / month, **tax included**, price can differ per customer. |
| 7 | **The invoice is Meteroid's PDF**, as Meteroid provides it. The **paid** invoice (Meteroid prints its payment status: Paid / Partly paid / Unpaid, with the payments) is the customer's receipt; Meteroid has no separate receipt document (`// TODO payment receipt` in its code). |
| 8 | **Sender:** `billing@trainertwin.com` (the `trainertwin.com` domain is already set up for sending). Replies go to `support@trainertwin.com` unless a `billing@` mailbox is set up. |
| 9 | **Billing details are entered in the studio:** a new **Settings › Billing** tab, not Meteroid's customer portal (reasons below). |
| 10 | **Admin and team** can see billing, upgrade and buy minutes. |
| 11 | **Overdue:** the org is **paused** as soon as a Paid renewal invoice passes its due date (2 days after renewal). |

### What the build changed (11 Nov 2026, from the spike on our Meteroid)

- **Invoice and receipt PDFs (decision 7):** Meteroid's PDF never shows that it was paid (its renderer passes no
  payment status, and it renders each PDF once) and can't be restyled. So the app draws both PDFs itself, from
  Meteroid's invoice data, in Stripe's layout (as on LiveKit's invoices, 11 Nov): the invoice (the tax invoice, with
  place of supply, both GSTINs, SAC per line, CGST/SGST or IGST, the export mention) and the receipt
  "RCPT-<invoice number>" with a payment history. Meteroid still numbers and calculates every invoice.
- **Currency:** every invoice is in **USD** for now (no INR prices were set). The app's PDFs show no INR conversion
  (Meteroid's did); whether Indian customers need INR invoices is asked of the accounts team.
- **Tax:** set per customer by the app from the billing address (Meteroid's custom taxes): Tamil Nadu CGST 9% + SGST
  9%, other states IGST 18%, abroad exempt with the LUT wording. Checked on real invoices. SAC 998314 is in the
  invoice footer (one SAC for everything we sell). Meteroid prints no state, so the app puts it on address line 2.
- **Packs:** 1 to 10 packs per purchase. Meteroid's top-ups are priced before tax, so the app picks the net price that
  lands on $25 × packs; with CGST and SGST rounded separately a few quantities come to 1 cent less (never more).
  Credits expire 365 days after the pack's invoice date (Meteroid sets the expiry when the invoice is made).
- **Upgrade:** the Paid subscription starts the day the upgrade is asked for (its first invoice is issued at once);
  the org moves to Paid when that invoice is paid. Unpaid when overdue: the invoice is voided and the subscription
  cancelled.
- **Trial:** the existing "Credits" subscription *is* the Trial plan; nothing changes in Meteroid for existing orgs.
- **Workflows:** upgrading and buying packs are one Meteroid call each, made directly from Settings › Billing; the
  workflows are `invoice-issued` (email, reminder, pause / cancel) and `invoice-paid` (plan, unpause, receipt email),
  plus a daily check (Vercel cron, 00:15 UTC) that repairs anything a lost webhook or failed workflow left.
- **Double-pay guard:** not needed in phase 2 (staff mark invoices paid in Meteroid; the app never does). Phase 3.
- **Meteroid setup** (`web/scripts/meteroid-billing-setup.ts`, per tenant): plan "Paid", MINS sold under a product
  ("Minute packs") at $0.25, our invoicing entity (address, GSTIN, SAC footer, 2-day terms, contact), webhook events.
- **Meteroid 2.2.1 quirks found:** webhooks carry their fields flat (not in `data`); `invoice.paid` arrives a moment
  before Meteroid's API shows the invoice paid (the paid workflow waits for it); a cancellation applies a moment later;
  the PDF is re-rendered briefly after payment; "Billing automation for SaaS" is printed in the PDF footer (not
  removable without whitelabel).

### Why our own Billing tab, not Meteroid's customer portal

Checked on our Meteroid (11 Nov): its portal lists invoices with PDFs and lets a customer edit legal name, address, tax
number and billing emails, but:
- **no state field** (India: street, postal code, city only), and the state decides CGST + SGST vs IGST;
- **payments only through Meteroid's own providers** (Stripe and the like), so no Razorpay "Pay" button;
- **no way to buy minute packs** (its Credit tab only says "contact your provider" or "redeem a code");
- a separate "Powered by Meteroid" site, reached by token links, showing Usage, Budget and promo-code sections we
  don't use.

## Who owns what

| Job | Owner |
| --- | --- |
| Plans, prices, renewal dates, subscription status (trial / active / overdue) | **Meteroid** |
| The org's credit balance (grants, packs, expiry, spending) | **Meteroid** (as in phase 1) |
| Each learner's own credits (given, used, left) | **Our app** (`MinuteLedger`, as in phase 1) |
| **The customer's invoice** (numbered, with tax; its paid copy is the receipt) | **Meteroid** creates it; **our app** emails it |
| The customer's billing details | Entered in **our app** (Settings › Billing), saved to the org's **Meteroid** customer |
| Collecting money | Phase 2: **by hand** (bank transfer). Phase 3: **Razorpay** |
| Marking an invoice paid | Phase 2: **you, in Meteroid**. Phase 3: **Razorpay webhook → our app → Meteroid** |
| Razorpay's fees, GST on those fees, currency conversion, settlement | **Razorpay's settlement reports → your accountant** (phase 3). Not in Meteroid, not on the invoice |
| All emails to customers | **Our app**, from `billing@trainertwin.com`, through workflows. Meteroid's and Razorpay's own customer emails are off |

Meteroid and Razorpay never talk to each other directly; the app connects them.

## What a customer receives (example: Olga, Dubai)

**Upgrading to Paid:** she fills in her billing details (Settings › Billing), clicks **Upgrade to Paid**, and gets the
first invoice by email ($300, payment instructions in phase 2, a **Pay now** button in phase 3). When it's paid her
org moves to the Paid plan from that day, and she gets the **paid copy** of the invoice.

**Every month after that:** two emails, both from TrainerTwin:
1. **On the renewal day: the invoice.** "Your TrainerTwin invoice: $300 for 3 Dec – 2 Jan", with the **invoice PDF**.
2. **When she has paid: the paid copy.** "Payment received, thank you", with the **same invoice showing Paid** (date,
   payment) and "your plan is active until 2 Jan".

If a renewal isn't paid within 2 days: one "your plan is paused" email; paying unpauses it at once.

**Buying minutes** (Paid orgs): "Buy 100 credits ($25)" in Settings › Billing → the pack invoice by email → when paid,
the paid copy, and the 100 credits are added (the phase 1 "credits added" email to the admin also goes out).

### What the invoice PDF shows

- **From:** Forever Learning Solutions Pvt Ltd, the address above, **GSTIN 33AAGCF6592D1ZN**, and for exports the
  **LUT reference** (when confirmed).
- **To:** the customer's legal name, address (with state for India), and tax number (GSTIN for Indian businesses;
  e.g. UAE TRN for Olga), from Settings › Billing.
- **Invoice number** (in sequence, by Meteroid), invoice date, due date.
- **Lines:** "TrainerTwin Paid plan, monthly, 3 Dec – 2 Jan: $300.00"; "Minute pack, 100 credits: $25.00".
- **Tax** (prices include it):
  - customer in **Tamil Nadu**: CGST 9% + SGST 9%;
  - customer in **another Indian state**: IGST 18%;
  - customer **abroad** (Olga): no Indian GST, with "Supply meant for export under LUT without payment of IGST";
  - **SAC 998314** on each line.
- **Total** and currency (INR or USD).
- **Payment status** (Unpaid / Paid with the payment), printed by Meteroid.

## What we build

### 1. Spike first (before anything else)

Check on our self-hosted Meteroid (dev tenant):
- the invoice PDF is **re-drawn as Paid** after payment (the stored copy isn't left "Unpaid"); if not, the app asks
  Meteroid to re-render it;
- **tax:** tax-inclusive prices, our GSTIN and the customer's tax number on the PDF (Meteroid supports these), and
  whether its tax engine can apply **CGST + SGST vs IGST vs none (export)** with SAC codes. If it can't, the fallback
  is that our app sets each customer's tax rate in Meteroid from the state / country in Settings › Billing;
- **upgrade after payment:** how to issue the first Paid invoice while the org stays on Trial and switch the plan only
  when it's paid (Meteroid has a checkout flow that creates the subscription when the payment settles; otherwise a
  one-off invoice, then the plan change);
- the **LUT** line on export invoices (template text / custom field).

### 2. Meteroid setup (dev tenant first, Sandbox rehearsal, Production only with your go-ahead)

- **Invoicing entity:** legal name, address and GSTIN (above), the LUT reference field, invoice number format (e.g.
  `TT-0001`), PDF branding.
- **Plans:**
  - **Trial:** $0, no expiry, no credits. Every org's plan to start with; replaces phase 1's **"Credits"** plan as the
    metering base (usage against the credit unit `MINS`). Existing orgs (olga, careerwithvasanth, latencytest) move
    from "Credits" to Trial.
  - **Paid:** $300 / month, tax included, no credits, price overridable per customer.
- **Minute pack:** 100 credits for $25, tax included, sold only to Paid orgs. A paid pack becomes a **PAID** credit
  grant (expiry: 365 days from payment, as in phase 1).
- **Payment terms:** due **2 days** after the renewal / issue date. (Today a top-up invoice is due in 30 days; set it
  explicitly.)
- **Per customer:** currency (INR or USD; it must be in the tenant's available currencies), legal name, address, tax
  number, billing emails (all from Settings › Billing).
- **Meteroid's own emails: admin only (done 11 Nov 2026).** Meteroid sends through Resend SMTP (`smtp.resend.com`,
  STARTTLS, its own send-only key `meteroid-smtp`; from `Forever Learning <billing@trainertwin.com>`, reply-to
  `support@trainertwin.com`): dashboard invites, password resets, alerts. **All 11 customer email kinds are switched
  off** in every tenant's invoicing entity (`disabled_kinds`), so customers only hear from the app. A **new tenant**
  starts with Meteroid's default (only reminders off): switch every customer kind off before it gets customers.

### 3. Studio: Settings › Billing (admin and team)

- **Billing details:** legal name, address (**country, state**, city, postal code, street), tax number (GSTIN checked
  for format, its first two digits must match the state; or a foreign tax number like a UAE TRN), billing emails, and
  the invoice currency (INR or USD). Saved to the org's Meteroid customer. Required before **Upgrade** or **Buy
  minutes**.
- **Plan:** Trial or Paid, status (active / due tomorrow / paused), next renewal date, **Upgrade to Paid**.
- **Invoices:** number, date, amount, status (due / paid / overdue), PDF download.
- **Buy minutes:** 100 credits for $25 (Paid orgs only; Trial orgs see "available on the Paid plan").
- **Payment instructions** (phase 2) / **Pay now** (phase 3).
- **Banners** across the studio: "invoice due tomorrow", "plan paused: pay to continue".

### 4. Workflows (in `web/workflows/`, one per file)

1. **`invoice-issued`**: when Meteroid issues an invoice (webhook): save it, email the invoice PDF to the billing
   emails (the org admin if none), show it in Settings › Billing; then wait until it's paid or its due date passes.
2. **Overdue** (a timer in `invoice-issued`): a **Paid renewal** invoice past its due date and unpaid → **pause the
   org** (no calls, no giving credits; learners can't start either), "plan paused" email and banner. An unpaid
   upgrade invoice leaves the org on Trial; an unpaid pack invoice adds nothing; neither pauses.
3. **`invoice-paid`**: when Meteroid says paid (webhook): email the **paid copy**, and then:
   - upgrade invoice → move the org to the Paid plan;
   - renewal → unpause if paused;
   - minute pack → the 100 credits are added (and the phase 1 "credits added" admin email).
4. **`upgrade-to-paid`** and **`buy-minutes`**: from Settings › Billing: check the billing details, ask Meteroid for
   the invoice → `invoice-issued`.
5. **A paused org can't spend credits:** calls and giving credits are refused with a clear message.

### 5. You, in Meteroid (phase 2)

Give free credits (grants), set a customer's custom price, and **mark invoices paid** when money arrives. The app
guards against recording a payment twice (Meteroid's `MarkInvoiceAsPaid` called twice records a double payment).

### 6. Data in the app (sketch)

- `OrgBilling`: plan (trial / paid), status (active / overdue), next renewal, paused since.
- A small `Invoice` copy (Meteroid id, number, kind upgrade / renewal / pack, amount, currency, status, due date, paid
  at, PDF reference, which emails went out), so Settings › Billing and the emails don't depend on Meteroid being
  reachable, and each email goes out once per invoice event.

## How we build it (same way as the people work)

1. `specs/billing.md`: the rules first, for review.
2. The spike (above). If something can't work, decide the fallback before building.
3. Build on the Meteroid **dev** tenant, locally: setup → Settings › Billing → workflows → pausing.
4. Tests by the test-writer agent; module specs by the spec-writer agent.
5. Rehearsal on a fresh prod copy against the **Sandbox** tenant, with a full runbook (like
   `plans/phase1-release.md`), including moving the three orgs to Trial.
6. Production (Meteroid Production setup and the release) **only with your go-ahead**, after fresh backups.

## Open questions

1. **LUT:** confirmed / filed, and its reference number (`GST_LUT_REFERENCE`; until then export invoices say "under
   LUT" without a number).
2. **How customers pay:** bank details for the invoice emails (`BILLING_PAYMENT_INSTRUCTIONS`) and/or a bank account
   on Meteroid's invoicing entity (printed on the PDF).
3. **INR prices**, if Indian customers should be invoiced in INR.

## Risks

- **Meteroid self-hosted gaps:** the Indian GST split or the paid PDF may need the fallbacks above (checked first).
- **Pausing a customer who has paid:** if an invoice isn't marked paid in time, the org pauses; the pause email tells
  them to reply if they've paid, and marking it paid unpauses it at once.
