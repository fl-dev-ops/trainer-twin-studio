# Billing phases 2 and 3 release runbook (plans, invoices, minute packs, pausing, paying online)

Rule spec: `specs/billing.md` (phase 3, Razorpay: rules 27–35). Phases 2 and 3 ship together. Built and rehearsed 11 Nov 2026: the whole lifecycle against Meteroid's **dev** tenant
(`web/scripts/billing-live-check.ts`, 13 checks), through the local app and UI against the **Sandbox** tenant (real
webhooks through the tunnel, real workflows), and the migration on a fresh copy of prod. Every step below is safe to
repeat. **Meteroid Production and the prod database change only with explicit go-ahead.**

Secrets: `~/.config/meteroid/keys.env`. Prod DB: `neon connection-string production --project-id bitter-forest-93765083
--org-id org-bitter-lake-26948244` (unpooled URL for the migration).

## Before (needs you)

1. **How customers pay** (shown to them in phase 2), either or both:
   - Vercel `trainer-twin-studio` production env `BILLING_PAYMENT_INSTRUCTIONS` (e.g. "Bank transfer to Forever
     Learning Solutions Pvt Ltd, A/c …, IFSC …, SWIFT …"), shown in the invoice, reminder and paused emails;
   - Meteroid › Production › Settings › Bank accounts: add the account and set it on the invoicing entity, so the PDF
     prints it.
2. **LUT:** once confirmed, `GST_LUT_REFERENCE` in the same Vercel env, **and** re-save customers who already saved
   billing details (the wording is copied into Meteroid when details are saved):
   `DATABASE_URL="$PROD" METEROID_API_KEY=$METEROID_PROD_API_KEY GST_LUT_REFERENCE=<ref> bun scripts/billing-sync-customers.ts`.
   Until then export invoices say "under LUT" without a number.
3. **Razorpay live** (phase 3):
   - Razorpay Dashboard (live mode) › Settings › API keys: generate the live key pair.
   - Confirm **International payments** are enabled (Account & Settings › International payments): customers pay in USD.
   - Dashboard › Webhooks › Add: URL `https://dash.trainertwin.com/api/razorpay/webhook`, a new secret, events
     **`payment_link.paid`** (and, for phase 1 purchases, `invoice.paid`, `refund.processed`).
   - Vercel `trainer-twin-studio` production env: `RAZORPAY_KEY_ID` (rzp_live_…), `RAZORPAY_KEY_SECRET`,
     `RAZORPAY_WEBHOOK_SECRET` (the webhook's secret), `RAZORPAY_ENABLED=true`. Without `RAZORPAY_ENABLED=true` the
     app bills exactly as phase 2 (bank transfer only, no Pay now).
4. Nothing else in Vercel: `METEROID_*`, `RESEND_*` and `CRON_SECRET` are already set; `METEROID_GRPC_URL` and
   `BILLING_FROM_EMAIL` default correctly.

## Release

1. **Backups, right before:** Neon branch `pre-billing-phase2-<date>` from `production`, and
   `pg_dump -Fc --no-owner --no-privileges -d "$PROD" -f ~/Backups/trainertwin/prod-pre-billing-phase2-<date>.dump`.
2. **Meteroid Production** (`cd web`, `set -a; . ~/.config/meteroid/keys.env; set +a`):
   ```sh
   METEROID_API_KEY=$METEROID_PROD_API_KEY bun scripts/meteroid-billing-setup.ts --webhook-url https://dash.trainertwin.com/api/meteroid/webhook --dry-run
   # expected (checked 11 Nov): create plan "Paid"; sell MINS under product "Minute packs"; MINS $0.25; invoicing
   # entity details; webhook + invoice.finalized/paid/voided, subscription.cancelled/ended
   METEROID_API_KEY=$METEROID_PROD_API_KEY bun scripts/meteroid-billing-setup.ts --webhook-url https://dash.trainertwin.com/api/meteroid/webhook
   ```
   All additive and invisible to customers: the current app ignores the new webhook events, the entity details only
   appear on new invoices, nobody is on the Paid plan. Customer emails are already off in every tenant (11 Nov).
   Then check in Meteroid › Production › Settings › Invoicing entity that the bank account (step "Before" 1) is still
   set (the script only sends the fields it sets; Meteroid keeps the rest).
3. **No old invoices to email:** the first daily check emails every invoice above $0 it hasn't seen. Prod has only
   the $0 Credits invoices (checked 11 Nov); confirm: `curl -s -H "Authorization: Bearer $METEROID_PROD_API_KEY"
   "https://meteroid-rest.foreverlearning.in/api/v1/invoices?per_page=100" | python3 -c "import json,sys; print([i['invoice_number'] for i in json.load(sys.stdin)['data'] if i['total']>0])"`
   prints `[]`.
4. **Merge the PR** → Vercel builds web and runs the migration (`20261112120000_billing_phase2`: adds columns and a
   table; every org stays on Trial). Chat, copilot and the voice agent are unchanged.
5. **Check:**
   - `/api/health` 200;
   - `DATABASE_URL="$PROD" bun scripts/check-billing.ts` and `check-org-people.ts`: all ok;
   - Settings › Billing loads for each org: "Trial plan, Active", no invoices, "Add your billing details first";
   - Vercel › Settings › Cron Jobs lists `/api/internal/billing/check` (00:15 UTC);
   - Meteroid › Production › Webhooks: the next delivery shows 200.
   - Razorpay: `curl -s -o /dev/null -w "%{http_code}" -X POST https://dash.trainertwin.com/api/razorpay/webhook` is
     **401** (on, signature checked), not 404 (off).
6. **No test invoices in prod:** invoices are numbered tax documents. The first real one is a customer's upgrade.

## The first customer (e.g. Olga)

1. Her admin (or you, signed in to her org as team) fills in Settings › Billing › Billing details: legal name,
   address, country, tax number (e.g. UAE TRN), billing emails.
2. Custom price, if agreed: `DATABASE_URL="$PROD" bun scripts/billing-price.ts --org olga --monthly <USD>` **before**
   the upgrade.
3. **Upgrade to Paid** → invoice email (PDF attached) to her billing emails.
4. She clicks **Pay now** (in the email, on the PDF or in Settings › Billing), pays by card in USD on Razorpay's page
   and comes back to Settings › Billing: "Payment received", Paid plan, receipt email, within seconds. Nothing to do
   for staff.
   Paid by bank transfer instead: **Meteroid › Production › Invoices › the invoice › Mark as paid** (amount = total,
   reference = bank transfer id; **once only**: Meteroid records a second payment if marked twice). Its Razorpay link
   is cancelled automatically.
5. Minute packs: Settings › Billing › Buy → straight to Razorpay → paid → credits arrive, "credits added" email.

## Day to day (staff)

- Online payments need nothing. Bank transfers: mark the invoice paid in Meteroid when the money arrives (as above). A
  paused org is unpaused as soon as its overdue renewal is paid.
- **Paid twice** (logged as `DUPLICATE payment … Refund it in Razorpay`, and `status = duplicate` in the fee report):
  refund it in Razorpay › Payments, and record a credit note in Meteroid if an invoice was involved.
- **Monthly fee report** for the accountant: `DATABASE_URL="$PROD" RAZORPAY_KEY_ID=… RAZORPAY_KEY_SECRET=…
  RAZORPAY_ENABLED=true bun scripts/billing-fee-report.ts --month 2026-12 > fees-2026-12.csv`.
- Free credits: a grant in Meteroid (unchanged from phase 1).
- Keep the invoicing entity's "Consolidate recurring invoices" **off** (it is, in every tenant): a consolidated
  invoice has no subscription, so a Paid renewal inside one wouldn't be recognised.
- A customer leaves: cancel their Paid subscription in Meteroid → back to Trial, unpaused.
- Something looks off: `bun scripts/check-billing.ts`; the daily check repairs lost webhooks; run it now with
  `curl -H "authorization: Bearer $CRON_SECRET" https://dash.trainertwin.com/api/internal/billing/check`.

## Rollback

Vercel instant rollback to the previous deployment. The migrations only add, so the old code runs on the new schema.
Online payments alone: set `RAZORPAY_ENABLED=false` (the app falls back to bank transfer; links already sent stop
being honoured by the webhook, so tell anyone who pays one).
The Meteroid changes are additive (an unused plan, a product on MINS, entity details, extra webhook events the old
code ignores). Data: the Neon branch from step 1.
