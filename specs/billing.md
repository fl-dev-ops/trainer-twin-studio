# Billing: plans, invoices, minute packs, receipts and pausing

> **A rule spec.** It says how billing *must* work; the code follows it, and a difference is a bug in the code.
> [Credits](credits.md) (spending), [Payments](payments.md) (phase 1 Razorpay purchases, off) and
> [People](people.md) (who gets which email) must agree with it. Agreed 11 Nov 2026 (`plans/billing-phase-2.md`);
> phase 3 (Razorpay collects the money, `plans/billing-phase-3.md`) adds online payment: rules 27–35.

## Who uses it

| Actor | What they do here |
| --- | --- |
| Org admin / team (studio) | Fill in billing details; upgrade to Paid; buy minute packs; see and download invoices and receipts. |
| Learner | Nothing: never sees billing. A paused org stops their calls. |
| TrainerTwin staff | In Meteroid: mark invoices paid when money arrives, give free credits, set a custom price (`web/scripts/billing-price.ts`), cancel a Paid plan. |
| Meteroid | Issues every invoice, renews the Paid plan monthly, grants a pack's credits when its invoice is paid, tells the app by webhook. |

## Words used here

| Term | Meaning (code name) |
| --- | --- |
| Billed org | An org linked to a Meteroid customer (`OrgBilling`). Orgs without one have no billing at all. |
| Plan | `trial` or `paid` (`OrgBilling.plan`). Trial: the Meteroid "Credits" subscription only (it meters credits; $0). Paid: also a Meteroid subscription on the "Paid" plan (`OrgBilling.paidSubscriptionId`). |
| Billing details | Legal name, address, tax number and billing emails (`OrgBilling.billingDetails`), copied to the Meteroid customer. |
| Invoice | A Meteroid invoice above $0, with the app's copy (`BillingInvoice`). Kinds: `upgrade` (the first invoice of a Paid subscription the org hasn't paid yet), `renewal` (every later Paid invoice), `pack` (a minute pack), `other` (anything staff made by hand). |
| Due date | The invoice's due date in Meteroid (2 days after it's issued for the Paid plan). An invoice is **overdue** from 00:00 UTC the day after its due date. |
| Paused | `OrgBilling.pausedAt` is set: a Paid renewal is overdue. |
| Receipt | The app's PDF saying an invoice was paid (rule 22). |

## Rules

### Plans and prices

1. **Every billed org starts on Trial**, existing ones too: Trial is the "Credits" subscription every billed org already
   has, so nothing changes in Meteroid. Trial costs nothing, never expires and includes no credits.
2. **Paid: $300 a month, tax included**, unless staff set a custom price for the org (`OrgBilling.paidMonthlyCents`).
   It includes no credits. All phase 2 invoices are in **USD** (whether Indian customers need INR invoices is with the accounts team).
3. **Credits come only from minute packs and grants** (staff, the 30-credit trial grant). A plan never adds credits.
4. **Minute pack: 100 credits for $25, tax included.** One purchase is 1 to 10 packs; the invoice total is $25 ×
   packs, or 1 cent less when GST rounding can't land on it exactly (CGST and SGST are rounded separately), never more. Its credits expire 365 days after the pack's invoice is issued.

### Who and what

5. **Admin and team** see Settings › Billing and do everything in it. Learners never see billing (403).
6. **Billing details come first.** Upgrading and buying packs are refused (400) until the org has billing details.
7. **Billing details rules** (any other field is refused too): legal name (1–200 characters); country (ISO code); street, city and postal code;
   **state when the country is India** (one of India's GST states, with its code); for India an optional GSTIN (15
   characters, the GST format, its first two digits equal to the state's code), elsewhere an optional tax number (up
   to 50 characters); 1 to 5 billing emails; a phone number with its country code (`+` then 8 to 15 digits: Razorpay
   needs it for card payments in USD). Anything else is refused (400) with the field's problem.
8. **Saving billing details** updates the Meteroid customer first (name, address, tax number, billing emails and tax),
   then the app's copy. When Meteroid can't be reached, nothing is saved and the person is told to try again (502);
   when it refuses, nothing is saved and they're told to contact TrainerTwin (502). Meteroid prints no state, so the state and its code go on the address's second line.
9. **Tax follows the billing address** (SAC 998314 on every invoice; prices include the tax):

   | Billing address | Tax on the invoice |
   | --- | --- |
   | India, Tamil Nadu (33) | CGST 9% + SGST 9% |
   | India, any other state | IGST 18% |
   | Outside India | None: "Supply meant for export under LUT (`GST_LUT_REFERENCE`) without payment of IGST" |

   An invoice uses the tax that applies when Meteroid issues it.

### Upgrading

10. **Upgrade to Paid** (Trial orgs only): the app creates the org's Paid subscription in Meteroid, starting today, due
    2 days after each invoice, never charged automatically. Meteroid issues the first (`upgrade`) invoice at once. The
    org stays on Trial, shown as "upgrade waiting for payment", until that invoice is paid. Asking again while one
    waits returns the same upgrade; a Paid or paused org is refused (409).
11. **Upgrade paid:** the org is on Paid from then on. Its plan renews every month on the day the upgrade was asked
    for.
12. **Upgrade not paid by its due date:** when it becomes overdue the app voids the invoice and cancels the
    subscription, and the org stays on Trial ("upgrade cancelled" email). It can upgrade again any time. If the
    invoice was paid in the meantime, nothing is cancelled.

### Renewals and pausing

13. **Renewal:** Meteroid issues the invoice on the renewal day; the app emails it at once.
14. **Reminder:** on the day before the due date (from 00:00 UTC to the end of that day), if it's still unpaid, one
    "due tomorrow" email. Never on another day.
15. **Pause:** when a renewal of the org's **current** Paid subscription becomes overdue unpaid, the org is paused (one "plan paused" email, and a banner across
    the studio). Only renewals pause; an unpaid upgrade, pack or `other` invoice never does.
16. **A paused org** can't start voice calls (admin, team or learner: refused with 403 and a message saying why and
    what to do), can't give credits to learners, and so can't add new learners either (they come with starting
    credits, [People](people.md) rule 9; refused with 403; someone who already had their starting credits in this org
    gets none and can be added). Calls already running continue to their limit. Nothing
    else stops: pages, reports, billing, adding admin or team members. Pausing never removes credits.
17. **Unpause:** when the overdue renewal is paid and the org has no other overdue renewal of its current
    subscription, it is unpaused at once; the receipt email says whether the plan is active or still paused.
18. **Plan ended:** when staff cancel the Paid subscription in Meteroid (it's cancelled or ends), the org goes back to
    Trial and is unpaused. Customers ask TrainerTwin to cancel; there's no cancel button.

### Minute packs

19. **Buying packs** is for Paid orgs that aren't paused (Trial: refused, "available on the Paid plan"; paused:
    refused, "pay the overdue invoice first"). The app asks Meteroid for a pack invoice (Meteroid's top-up, sent as an
    invoice); Meteroid adds the credits as soon as the invoice is marked paid, and the phase 1 "credits added" email
    goes to the admin (phase 1's people email, from the usual sender). An unpaid pack invoice adds nothing and never
    pauses; it can still be paid later.

### Invoices, receipts and emails

20. **Marking paid:** a Razorpay payment (card, or bank transfer through Razorpay) marks its invoice paid
    automatically (rules 29–31). A payment made outside Razorpay is marked paid by staff in Meteroid. The app never
    prints bank details: an invoice without a payment link says to reply to the email for one.
21. **Emails** come only from the app, from `billing@trainertwin.com` (reply-to `support@trainertwin.com`), to the
    org's billing emails (the org admin when there are none). Meteroid's own customer emails are off in every tenant.

    | Event | Email | Attached |
    | --- | --- | --- |
    | Invoice issued (any kind) | "Your TrainerTwin invoice INV-… : $… due …", with Pay now (rule 28) | The invoice PDF |
    | Due tomorrow (renewal only) | "Reminder: invoice … is due tomorrow" | The invoice PDF |
    | Paused (renewal only) | "Your TrainerTwin plan is paused" | The invoice PDF |
    | Upgrade cancelled | "Your upgrade was cancelled" | — |
    | Invoice paid (any kind) | "Payment received for INV-…", and what it did (Paid plan active, plan active again, credits added) | Receipt PDF and the invoice PDF |

    Each email goes out **once** per invoice and event (Resend idempotency key `billing-<event>-<invoice id>`, and the
    app's record of it), even when Meteroid sends a webhook again or a workflow step retries.
22. **The PDFs** are drawn by the app (`web/lib/billing/documents.ts`) in one layout (Stripe's), from Meteroid's
    invoice: its number, dates, lines, tax and the customer as it was when issued. Meteroid's own PDF isn't used (it
    can't be restyled and never shows a payment).
    - **Invoice** (the tax invoice): number, date of issue, date due, place of supply (state and code, or "outside
      India (export of services)"); the seller (name, address, GSTIN, email: Meteroid's invoicing entity, the one
      place the company's details are kept and edited) and the customer (name, address with state, GSTIN or tax ID,
      email); the amount due; Pay online while it's unpaid (rule 28); each line with SAC 998314 (and its period);
      taxable value, CGST/SGST or IGST, total; the export mention when exempt; "computer generated, needs no
      signature".
    - **Receipt** "RCPT-<invoice number>": the same header and lines, "amount paid on <date>", and a payment history
      (method, reference, date, amount). Downloadable from Settings › Billing once paid.
    The same invoice renders the same bytes every time (dates come from the invoice and payment).
23. **Invoices above $0 only:** a $0 invoice (the Credits subscription's monthly one) is never stored, shown or emailed.

### Keeping in step with Meteroid

24. **Webhooks** (signed, as in phase 1): `invoice.finalized` starts the invoice-issued workflow; `invoice.paid`
    starts the invoice-paid workflow; `invoice.voided` marks the copy void (no more reminders); `subscription.cancelled`
    and `subscription.ended` for the org's Paid subscription apply rule 18. Each workflow starts once per invoice and
    event. A customer that isn't an org is acknowledged and ignored.
25. **Daily check** (cron): for every billed org, reads Meteroid's recent invoices and repairs anything a lost
    webhook or a failed workflow left behind: a missing invoice copy (and its email), a payment not handled, a void,
    an overdue renewal not paused (or its email not sent), an overdue upgrade not cancelled (or not finished), an org
    paused with nothing overdue (unpaused), the Paid subscription ended in Meteroid (rule 18), a workflow that died
    before its email (claimed over 10 minutes ago). Reminders are best effort: a missed one isn't sent later.
26. **Meteroid down:** Settings › Billing shows the app's copy; saving details, upgrading and buying packs fail with
    a message to try again (502) and change nothing. Starting a call reads only the app's copy, so calls never wait on
    Meteroid. Pausing and unpausing ask Meteroid first whether the invoice was paid, so they wait until it's back
    (the workflow step retries; the daily check catches up).

### Paying online (Razorpay, phase 3)

27. **One payment link per invoice.** With Razorpay on (`RAZORPAY_ENABLED=true`), every unpaid invoice above $0, of
    any kind, gets one Razorpay payment link: its exact total and currency (USD), no partial payments, no expiry, the
    customer's billing name, first billing email and phone. Razorpay sends nothing itself (no email, SMS or reminders).
    The link is made once (its Razorpay reference is the invoice id: a retry finds it instead of making another),
    when the invoice is first handled: the invoice-issued workflow, an upgrade, a pack. An invoice whose org has no
    phone saved gets no link (bank transfer only) until it has one.
28. **Pay now** appears wherever the invoice does: the invoice, reminder and paused emails (a button), the invoice PDF
    ("Pay online" and the link), and Settings › Billing (a button on each unpaid invoice and in the upgrade and paused
    notices). "Upgrade to Paid" and "Buy" take the person straight to the payment page; after paying they come back
    to Settings › Billing, which shows the payment within seconds.
29. **A payment** (Razorpay's signed `payment_link.paid` webhook) counts only when the link is the invoice's and the
    amount and currency equal the invoice total. Then, once per Razorpay payment: the payment is recorded; the Meteroid
    invoice is marked paid with the Razorpay payment id as its reference, unless Meteroid already shows it paid; and
    rules 11, 17, 19 and 21 follow as for any paid invoice.
30. **Wrong amount, wrong currency or an unknown link:** nothing changes; it's logged for staff; Razorpay is answered
    200 so it stops retrying.
31. **Paid twice** (a card payment after a bank transfer was marked, or two payments): the invoice is marked paid once;
    the extra payment is recorded as a duplicate and logged for staff to refund by hand.
32. **A link closes** when its invoice is voided (an upgrade cancelled, staff) or paid another way: the app cancels it
    in Razorpay so it can't be paid again.
33. **Missed webhooks:** the daily check asks Razorpay about the link of every unpaid invoice and settles any paid one
    the same way (rule 29), and makes the links rule 27 is missing.
34. **Fee report:** every Razorpay payment is kept with its amount and currency, the INR it converted to, Razorpay's
    fee and the GST on that fee, the method and whether it was international.
    `web/scripts/billing-fee-report.ts --month YYYY-MM` writes them as a CSV for the accountant, with Razorpay's
    settlement id and date once settled. Refunds are done by hand in Razorpay and as a credit note in Meteroid.
35. **Phase 1 credit purchases** (a Razorpay link or invoice tied to a `CreditPurchase`) keep working through the same
    webhook, unchanged.

## Checks (must always hold; `web/scripts/check-billing.ts`)

- Every `paid` org has a Paid subscription id; every `trial` org with a Paid subscription id has an unpaid `upgrade`
  invoice of it (an upgrade asked for in the last hour may not have its copy yet).
- Every paused org is `paid` and has an overdue unpaid `renewal`.
- No `paid` org that isn't paused has a renewal of its current subscription unpaid since before yesterday (the 00:15 UTC
  daily check has had its chance).
- Every `BillingInvoice` belongs to a billed org and has a total above 0.
- Every Razorpay payment that settled an invoice is recorded once, and that invoice is paid; with Razorpay on, every
  unpaid invoice above $0 older than an hour whose org has a phone has a payment link.
- Every paid invoice has had its "paid" email; every invoice that isn't void its "issued" email (allowing an hour for
  a running workflow; the daily check sends any a dead workflow left).

Run in the test suites, in every release rehearsal, and after every release.
