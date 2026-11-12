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

- [x] **Accountant:** LUT (RFD-11) for FY 2026-27 — not filed yet (11 Nov); the CA files it and sends the ARN. Until
      then **every org stays on Trial** and no export invoice is issued (export invoices must be dated on/after the
      filing, with "Export of services without payment of tax under LUT / LUT ARN: …", which the app prints).
- [x] **LUT ARN received** (AD331126012484I, filed 11 Nov 2026; set in dev, Sandbox and Production 11 Nov) → type it into **Meteroid Production › Settings › Invoicing entity › legal footer**
      ("LUT ARN: AD33…"). The app reads it from there; nothing to deploy.
- [ ] **Accountant:** SAC **998314** right for what we sell? (one constant: `SAC` in `web/lib/billing/documents.ts`)
- [ ] **Accountant:** USD invoices for Indian customers OK? (everyone pays in USD today; INR would need INR prices)
- [ ] **Accountant:** one continuous invoice series `INV-0001…` OK, or a new series each financial year?
- [x] **Plans (decided 11 Nov):** Trial for every org; paid plans are per org, made in Meteroid (Olga: a `CUSTOM` plan,
      $300/month, tax included). No upgrade button in the app; staff subscribe the org in Meteroid. Plan options and
      switching in the app: issue #19 (later). Packs: 100 credits for $25, tax included.
- [x] **Invoice copies kept unchanged (decided 11 Nov):** each invoice and receipt PDF is saved to S3 as first sent.
- [x] **Payment terms (decided 11 Nov):** set in Meteroid on each org's plan or subscription; the org is paused the
      day after the due date. Nothing in the code to change.
- [x] **Phase 1 Razorpay credit-purchase scripts:** kept for development only (not used in production).
- [x] **Existing orgs:** all stay on Trial until the ARN; then staff subscribe Olga to her $300 plan in Meteroid.
      careerwithvasanth stays on Trial.
- [ ] **Olga today (phase 1, already live):** you add **1,000 minutes** to olga in Meteroid Production (Customers ›
      olga › Credits › grant); she gets the "credits added" email, gives credits to her learners, they practise.

## B. Setup outside the code (before merge)

- [x] **Meteroid Production › Settings › Invoicing entity:** company name, address, GSTIN, contact email right *(11 Nov: address set to the GST registration, all three tenants.)*
      (invoices read them from here); legal footer = "LUT ARN: …" once received. The setup script fills it only if empty.
- [x] **Meteroid customer emails off** in every tenant (done 11 Nov; check `disabled_kinds` has all 11 kinds for prod).
- [ ] **Razorpay live:** generate live API keys; confirm **International payments** are on (customers pay in USD).
- [ ] **Razorpay live webhook:** Dashboard › Webhooks › Add `https://dash.trainertwin.com/api/razorpay/webhook`, a new
      secret, events `payment_link.paid` (and `invoice.paid`, `refund.processed` for phase 1 purchases).
- [ ] *(Optional)* Razorpay › International payments › **International bank transfers** › Activate (customers abroad
      can pay by bank transfer on the same Pay now page). No app setting.
- [ ] **Vercel** `trainer-twin-studio` › Production env: `RAZORPAY_KEY_ID` (rzp_live_…), `RAZORPAY_KEY_SECRET`,
      `RAZORPAY_WEBHOOK_SECRET`. (Already set: `METEROID_*`, `RESEND_*`, `CRON_SECRET`, `S3_*` / `AWS_*` for the kept PDFs.)
- [ ] *(Test mode, optional)* Razorpay **test** webhook → `https://dev-webhooks.foreverlearning.in/api/razorpay/webhook`,
      secret = `RAZORPAY_WEBHOOK_SECRET` in `web/.env`, event `payment_link.paid`: to see real deliveries once.

## C. Release (merge day, in order)

- [x] **No old invoices to email:** prod Meteroid has no invoice above $0 (checked 11 Nov: 3 invoices, all $0):
      `curl -s -H "Authorization: Bearer $METEROID_PROD_API_KEY" "https://meteroid-rest.foreverlearning.in/api/v1/invoices?per_page=100" | python3 -c "import json,sys; print([i['invoice_number'] for i in json.load(sys.stdin)['data'] if i['total']>0])"` prints `[]`.
- [x] **Backups right before:** Neon branch `pre-billing-<date>` from `production`; and
      `pg_dump -Fc --no-owner --no-privileges -d "$PROD" -f ~/Backups/trainertwin/prod-pre-billing-<date>.dump`.
- [x] **Meteroid Production setup** (go-ahead), dry-run first, then for real:
      `METEROID_API_KEY=$METEROID_PROD_API_KEY bun scripts/meteroid-billing-setup.ts --webhook-url https://dash.trainertwin.com/api/meteroid/webhook --dry-run`
      (expected: sell MINS under product "Minute packs"; MINS $0.25; invoicing entity (only if empty); webhook +
      invoice.finalized/paid/voided, subscription.cancelled/ended). All additive; the current app ignores the new
      webhook events.
- [x] **Merge PR #18** → Vercel builds web and runs migrations `20261112120000_billing_phase2` and *(merged 11 Nov, `47ff272`; backup branch `br-round-brook-azvxs0oy`, dump `prod-pre-billing-release-20261111-1407.dump`.)*
      `20261113120000_billing_razorpay` (add-only; every org stays on Trial). Chat, copilot, voice agent unchanged.

## D. After deploy (same day)

- [x] `/api/health` 200.
- [x] `DATABASE_URL="$PROD" bun scripts/check-billing.ts` and `bun scripts/check-org-people.ts`: all ok.
- [ ] Settings › Billing loads for each org: "Trial plan, Active", "contact TrainerTwin" to upgrade, no prices shown.
- [ ] Vercel › Settings › Cron Jobs lists `/api/internal/billing/check` (00:15 UTC).
- [x] Meteroid › Production › Webhooks: next delivery 200.
- [x] Razorpay webhook: `curl -s -o /dev/null -w "%{http_code}" -X POST https://dash.trainertwin.com/api/razorpay/webhook`
      is **401** (signature checked; 500 = `RAZORPAY_WEBHOOK_SECRET` missing).
- [ ] Nothing from the old flows broke: a team call starts and ends; Credits page balances as before.
- [ ] Remove `VERCEL_FORCE_NO_BUILD_CACHE` from Vercel if still there (phase 1 leftover).

## E. First paid customer (Olga, once the LUT ARN is in Meteroid)

- [ ] Her billing details filled in (legal name, address, tax ID, billing emails, **phone**) — by her admin or by you.
- [ ] In Meteroid Production: create her **plan** (type Custom, e.g. "Olga – $300/month", USD, tax included, payment
      terms as agreed, monthly rate $300) and her **subscription** on it (start today, not charged automatically).
- [ ] The invoice email with Pay now reaches her billing emails; her Billing page shows "Upgrade waiting for payment".
      The invoice is dated today (on/after the LUT filing) and shows the LUT declaration and ARN.
- [ ] She pays → "Payment received"; Paid plan; receipt email; payment in Razorpay and in the fee report.
- [ ] (Paid outside Razorpay instead: Meteroid › Invoices › Mark as paid, amount = total, **once**; its link is
      cancelled automatically.)
- [ ] **One month later: watch the first real renewal** (never seen live; Meteroid's clock can't be sped up):
      invoice email on the renewal day, "due tomorrow" reminder, payment, receipt. Check `check-billing.ts` after.

## F. Ongoing

- [ ] Monthly: fee report for the accountant —
      `DATABASE_URL="$PROD" RAZORPAY_KEY_ID=… RAZORPAY_KEY_SECRET=… bun scripts/billing-fee-report.ts --month YYYY-MM > fees.csv`.
- [ ] Duplicate payments (log `DUPLICATE payment … Refund it in Razorpay`; `duplicate` rows in the fee report):
      refund in Razorpay; credit note in Meteroid if an invoice was involved.
- [ ] Each financial year: a new LUT → update the ARN in Meteroid's invoicing entity legal footer (April).
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
