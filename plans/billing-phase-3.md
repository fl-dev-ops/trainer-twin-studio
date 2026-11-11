# Billing phase 3: Razorpay collects the money

Status: **plan, decisions agreed 11 Nov 2026**; nothing built yet. Builds on phase 2
(`plans/billing-phase-2.md`): who owns what, what the customer receives and the invoice PDF are defined there and don't
change. Start after phase 2 has run a billing cycle.

**Goal:** customers pay online through Razorpay, and payments are recorded automatically. Meteroid still issues the
invoice; our app still sends every email; Razorpay only collects the money.

## Decisions (11 Nov 2026)

| # | Decision |
| --- | --- |
| 1 | **International payments are enabled** on the live Razorpay account: Olga can pay in USD by card. |
| 2 | **Fee report: yes.** The app keeps, per payment, the amount paid, Razorpay's fee, the GST on that fee and the INR settled, for a monthly report to your accountant. |
| 3 | **Refunds: by hand, no build now.** A refund is done in Razorpay, and recorded in Meteroid by hand as a credit note (a few clicks), so the invoices match the money. Automate from Razorpay's refund webhook only if refunds become common. |
| 4 | The upgrade to Paid, minute packs (Paid orgs only) and everything else from phase 2 stay as they are; phase 3 only adds online payment. |

## What we build

- **Payment link per invoice:** when an invoice is issued, the workflow creates a **Razorpay payment link** for its
  amount and currency (invoice number in its notes), and the invoice email and Billing page show **Pay now**.
  Razorpay's own invoice / receipt emails are **off** (`notify` off); Razorpay only runs the checkout page.
- **Paid:** Razorpay's webhook (payment link paid) → the app checks the signature and the amount → marks the Meteroid
  invoice paid (**once**, guarded: Meteroid's gRPC `MarkInvoiceAsPaid`, already wrapped as `markInvoicePaid` in
  `web/lib/billing/meteroid.ts`) → phase 2's `invoice-paid` workflow (receipt, unpause, Paid plan; pack credits).
- **Self-serve:** "Upgrade to Paid" and "Buy minutes" (Paid orgs) pay right away; the plan changes / the credits arrive
  within seconds of paying.
- **Daily reconcile workflow:** compares Razorpay payments with open invoices and settles any whose webhook was
  missed.
- **Turning Razorpay back on:** `RAZORPAY_ENABLED=true`, live keys, the Razorpay webhook. The Razorpay code from
  PR #15 (switched off today) is reused.
- **Refunds:** by hand, in Razorpay; recorded in Meteroid by hand as a credit note (decision 3).
- **Fees, GST on fees, currency conversion:** Razorpay deducts its fee (about 2% + 18% GST on it for Indian payments;
  about 3% + GST for international cards) and settles **net, in INR** (international: about T+7 working days, at the
  processing bank's rate). None of this touches the customer's invoice or Meteroid. The app stores each payment's
  gross, fee, tax on fee and settled INR for the monthly report (decision 2).

## Why not Razorpay's invoices

Checked against Razorpay's docs (11 Nov 2026): its **API can only create non-GST invoices** (no tax rate, HSN/SAC or
CGST/SGST/IGST); GST invoices can be made **only by hand in the Razorpay Dashboard**; invoices in **USD are always
non-GST** (no export/LUT wording). Razorpay's automatic "payment successful" email is a payment confirmation, not a
tax invoice. So Razorpay collects the money and Meteroid issues the invoice.

## What changes for the customer (example: Olga)

Same two emails as in phase 2, from TrainerTwin. The invoice email now has a **Pay now** button (Razorpay checkout:
card in USD for Olga, UPI / cards / netbanking for Indian customers) instead of payment instructions, and the receipt
(the app's, with the invoice) arrives within seconds of paying. She gets **no** emails from Razorpay or Meteroid.

## How we build it

1. Add the Razorpay rules to `specs/billing.md` first, for review.
2. Build against Razorpay **test mode** and the Meteroid **dev** tenant, locally (the dev webhook tunnel
   `dev-webhooks.foreverlearning.in` carries Razorpay's test webhooks too).
3. Tests by the test-writer agent; module specs by the spec-writer agent.
4. Rehearsal on a fresh prod copy against the **Sandbox** tenant and Razorpay test mode.
5. Production: live Razorpay keys, the live webhook and `RAZORPAY_ENABLED=true`, **only with your go-ahead**.

## Open questions

None for now (international payments, the fee report and refunds were decided on 11 Nov 2026).

## Risks

- **Two systems, one truth:** amounts must match between the Meteroid invoice and the Razorpay link; the app checks
  the amount on every webhook and never marks paid twice (Meteroid would record a double payment).
- **A missed webhook** could leave a paid invoice unpaid and pause the org; the daily reconcile settles it, and the
  pause email tells the customer to reply if they've paid.
