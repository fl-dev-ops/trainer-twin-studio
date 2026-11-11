# Billing phases 2 and 3: release checklist

One list, in order, for releasing PR #18 (plans, invoices, minute packs, pausing, paying online through Razorpay).
Tick each box as it's done. Rule spec: `specs/billing.md`; plans: `plans/billing-phase-2.md`, `plans/billing-phase-3.md`.
**Meteroid Production, Razorpay live and the prod database change only with explicit go-ahead.**

Secrets: `~/.config/meteroid/keys.env`. Prod DB: `neon connection-string production --project-id bitter-forest-93765083
--org-id org-bitter-lake-26948244` (unpooled URL for migrations). In the commands, `cd web` and
`set -a; . ~/.config/meteroid/keys.env; set +a` first.

Status, 11 Nov 2026: built, tested (DB 390/0, flows 140/0, unit green except 5 failures also on `v2`), rehearsed on
Meteroid dev and Sandbox with real Razorpay test payments, migrations checked on a fresh prod copy. Not merged.

## A. Decisions and answers (before merge)

- [ ] **Accountant:** LUT (RFD-11) filed for FY 2026-27 for GSTIN 33AAGCF6592D1ZN? (ARN optional, for
      `GST_LUT_REFERENCE`). Without it, export invoices must charge IGST: don't invoice customers abroad until it's filed.
- [ ] **Accountant:** SAC **998314** right for what we sell? (one constant: `SAC` in `web/lib/billing/documents.ts`)
- [ ] **Accountant:** USD invoices for Indian customers OK? (everyone pays in USD today; INR would need INR prices)
- [ ] **Accountant:** one continuous invoice series `INV-0001…` OK, or a new series each financial year?
- [ ] **Prices final:** Paid $300/month and packs 100 credits for $25, both tax included. Custom price for anyone
      (Olga?) — set with `scripts/billing-price.ts` **before** that org upgrades.
- [ ] **Invoice copies kept unchanged:** today the PDFs are drawn when emailed or downloaded, with the company's
      details as Meteroid has them *then*. If the address or GSTIN ever changes, old invoices would show the new one.
      Decide: snapshot the seller onto each invoice when it's issued (small change, recommended), or accept it.
- [ ] **Pausing policy:** Paid renewal due 2 days after it's issued; paused from the day after. OK for real
      customers (e.g. Olga), or a longer grace?
- [ ] **Phase 1 Razorpay credit-purchase scripts** (`org-payment-link.ts`, `link-invoice.ts`, `reconcile-purchases.ts`):
      keep as a staff tool, or retire now that packs exist?
- [ ] **Who upgrades the existing orgs, and when** (olga, careerwithvasanth, latencytest all start on Trial).

## B. Setup outside the code (before merge)

- [ ] **Meteroid Production › Settings › Invoicing entity:** company name, address, GSTIN, contact email right
      (invoices read them from here). The setup script fills it only if empty.
- [ ] **Meteroid customer emails off** in every tenant (done 11 Nov; check `disabled_kinds` has all 11 kinds for prod).
- [ ] **Razorpay live:** generate live API keys; confirm **International payments** are on (customers pay in USD).
- [ ] **Razorpay live webhook:** Dashboard › Webhooks › Add `https://dash.trainertwin.com/api/razorpay/webhook`, a new
      secret, events `payment_link.paid` (and `invoice.paid`, `refund.processed` for phase 1 purchases).
- [ ] *(Optional)* Razorpay › International payments › **International bank transfers** › Activate (customers abroad
      can pay by bank transfer on the same Pay now page). No app setting.
- [ ] **Vercel** `trainer-twin-studio` › Production env: `RAZORPAY_KEY_ID` (rzp_live_…), `RAZORPAY_KEY_SECRET`,
      `RAZORPAY_WEBHOOK_SECRET`. (Already set: `METEROID_*`, `RESEND_*`, `CRON_SECRET`.) Optional: `GST_LUT_REFERENCE`.
- [ ] *(Test mode, optional)* Razorpay **test** webhook → `https://dev-webhooks.foreverlearning.in/api/razorpay/webhook`,
      secret = `RAZORPAY_WEBHOOK_SECRET` in `web/.env`, event `payment_link.paid`: to see real deliveries once.

## C. Release (merge day, in order)

- [ ] **No old invoices to email:** prod Meteroid has no invoice above $0 (checked 11 Nov: 3 invoices, all $0):
      `curl -s -H "Authorization: Bearer $METEROID_PROD_API_KEY" "https://meteroid-rest.foreverlearning.in/api/v1/invoices?per_page=100" | python3 -c "import json,sys; print([i['invoice_number'] for i in json.load(sys.stdin)['data'] if i['total']>0])"` prints `[]`.
- [ ] **Backups right before:** Neon branch `pre-billing-<date>` from `production`; and
      `pg_dump -Fc --no-owner --no-privileges -d "$PROD" -f ~/Backups/trainertwin/prod-pre-billing-<date>.dump`.
- [ ] **Meteroid Production setup** (go-ahead), dry-run first, then for real:
      `METEROID_API_KEY=$METEROID_PROD_API_KEY bun scripts/meteroid-billing-setup.ts --webhook-url https://dash.trainertwin.com/api/meteroid/webhook --dry-run`
      (expected: create plan "Paid"; sell MINS under product "Minute packs"; MINS $0.25; invoicing entity (only if
      empty); webhook + invoice.finalized/paid/voided, subscription.cancelled/ended). All additive; the current app
      ignores the new webhook events.
- [ ] **Merge PR #18** → Vercel builds web and runs migrations `20261112120000_billing_phase2` and
      `20261113120000_billing_razorpay` (add-only; every org stays on Trial). Chat, copilot, voice agent unchanged.

## D. After deploy (same day)

- [ ] `/api/health` 200.
- [ ] `DATABASE_URL="$PROD" bun scripts/check-billing.ts` and `bun scripts/check-org-people.ts`: all ok.
- [ ] Settings › Billing loads for each org: "Trial plan, Active", "Add your billing details first".
- [ ] Vercel › Settings › Cron Jobs lists `/api/internal/billing/check` (00:15 UTC).
- [ ] Meteroid › Production › Webhooks: next delivery 200.
- [ ] Razorpay webhook: `curl -s -o /dev/null -w "%{http_code}" -X POST https://dash.trainertwin.com/api/razorpay/webhook`
      is **401** (signature checked; 500 = `RAZORPAY_WEBHOOK_SECRET` missing).
- [ ] Nothing from the old flows broke: a team call starts and ends; Credits page balances as before.
- [ ] Remove `VERCEL_FORCE_NO_BUILD_CACHE` from Vercel if still there (phase 1 leftover).

## E. First real customer (e.g. Olga)

- [ ] Custom price set first if agreed (`scripts/billing-price.ts`).
- [ ] Billing details filled in (legal name, address, tax ID, billing emails, **phone**).
- [ ] **Upgrade to Paid** → Razorpay page; invoice email with Pay now arrives at her billing emails.
- [ ] She pays → back on Settings › Billing "Payment received"; Paid plan; receipt email; Razorpay payment visible
      in the Razorpay dashboard and in `scripts/billing-fee-report.ts`.
- [ ] (Paid outside Razorpay instead: Meteroid › Invoices › Mark as paid, amount = total, **once**; its link is
      cancelled automatically.)
- [ ] **One month later: watch the first real renewal** (never seen live; Meteroid's clock can't be sped up):
      invoice email on the renewal day, "due tomorrow" reminder, payment, receipt. Check `check-billing.ts` after.

## F. Ongoing

- [ ] Monthly: fee report for the accountant —
      `DATABASE_URL="$PROD" RAZORPAY_KEY_ID=… RAZORPAY_KEY_SECRET=… bun scripts/billing-fee-report.ts --month YYYY-MM > fees.csv`.
- [ ] Duplicate payments (log `DUPLICATE payment … Refund it in Razorpay`; `duplicate` rows in the fee report):
      refund in Razorpay; credit note in Meteroid if an invoice was involved.
- [ ] Once the LUT ARN is known: set `GST_LUT_REFERENCE` in Vercel, redeploy, then
      `DATABASE_URL="$PROD" METEROID_API_KEY=$METEROID_PROD_API_KEY GST_LUT_REFERENCE=<ref> bun scripts/billing-sync-customers.ts`.
- [ ] A customer leaves: cancel their Paid subscription in Meteroid → back to Trial.
- [ ] Before any Meteroid upgrade: re-run `scripts/billing-live-check.ts` on the dev tenant (the app uses Meteroid's
      dashboard API for void / mark paid / company details, which isn't a public contract). Keep "Consolidate
      recurring invoices" **off** on the invoicing entity.
- [ ] Clean-up of test data: Sandbox INV-0112 has a double payment from before the fix; local DB latencytest is on
      Paid with Sandbox test invoices; scratch DB `trainertwin_rehearsal`.

## Rollback

Vercel instant rollback to the previous deployment (the migrations only add; the old code runs on the new schema).
Online payments only: remove the live Razorpay keys from Vercel and redeploy (invoices go out without Pay now; staff
mark payments in Meteroid). The Meteroid changes are additive. Data: the Neon branch from C.
