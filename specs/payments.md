# Payments

> This is the retained **phase 1 Razorpay** purchase module. Razorpay is always on; `RAZORPAY_ENABLED` has been removed. Staff sell prepaid org credits at an agreed price; paid links/Dashboard invoices create PAID Meteroid grants, refunds only log, and reconciliation recovers missed payments. **Phase 3 invoice payments** use the same API and webhook, but settle Meteroid Paid/pack/other invoices rather than `CreditPurchase` records; see [Billing code](billing-code.md#razorpay-collecting-invoice-payments) and [Billing rules](billing.md) rules 27–35. Phase 1 purchases still work unchanged through the webhook and scripts, with no enable switch. See [Credits](credits.md) for spending (`web/lib/razorpay.ts` `call`; `web/lib/credit-purchases.ts` `purchasePaid`, `reconcilePurchases`; `web/app/api/razorpay/webhook/route.ts` POST).

## Who uses it

| Who | What they do | Code |
| --- | --- | --- |
| TrainerTwin staff | Create links, link Dashboard invoices, report/apply missed payments. | `web/scripts/org-payment-link.ts`, `link-invoice.ts`, `reconcile-purchases.ts` |
| Payer | Pays on Razorpay's hosted page; may receive Razorpay email/SMS. | `web/lib/razorpay.ts` `createPaymentLink` |
| Admin / team | See credits and Meteroid grant history, not purchase management. | `web/components/credits/credits-page.tsx`; `web/lib/minutes-trpc.ts` |
| Razorpay | Sends signature-authenticated payment/refund callbacks. | `web/app/api/razorpay/webhook/route.ts` |

## Words used here

- **Credit:** one minute; bought for the org, not directly for a learner (`web/lib/credit-purchases.ts` `purchasePaid`).
- **Purchase:** one agreement about credits, money, currency and a Razorpay link/invoice (`web/prisma/schema.prisma` `CreditPurchase`).
- **Subunit:** paise for INR, cents for USD. Input prices use major units; storage uses subunits (`web/lib/credit-purchases.ts` `toSubunits`).
- **Claim:** atomically changing a created purchase to paid, before calling Meteroid (`web/lib/credit-purchases.ts` `purchasePaid`).

## Data

`CreditPurchase` stores org, positive integer credits/amount, INR/USD currency, `payment_link`/`invoice` kind, unique nullable `razorpayId` and `paymentId`, hosted URL, operator note and timestamps. SQL constraints live in `web/prisma/migrations/20261109120000_credit_purchases/migration.sql`; schema in `web/prisma/schema.prisma`.

Current lifecycle is `created → paid`; a failed Meteroid grant unclaims a newly claimed purchase back to created, clearing paymentId/paidAt. Legacy `partially_refunded`, `refunded` and `refundedAmount` remain in the schema but refund callbacks no longer update them. Failed link creation deletes the local row on a best-effort basis (`web/lib/credit-purchases.ts`).

No payment/refund appends `MinuteLedger` org movements. Bought credits live in Meteroid, with `OrgBilling` as the app's cached copy (`web/lib/credit-purchases.ts`; `web/lib/org-credits.ts`).

## How it works

### Shared Razorpay API and webhook

Razorpay is always on ([Billing](billing.md) rule 27). `RAZORPAY_ENABLED` has no effect, including unset or `false`; `razorpayEnabled` and `RazorpayDisabledError` no longer exist. Every shared API call attempts the external request once `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are present; missing trimmed keys throw before fetch. POST `/api/razorpay/webhook` always reads the body and checks its signature, with no off-mode 404. Retained phase 1 link/invoice/reconcile scripts are no longer gated by a switch; their production-key guard is unchanged. The shared webhook still dispatches phase 1 payments and log-only refunds to the same helpers (`web/lib/razorpay.ts` `env`, `call`, `verifyWebhookSignature`; `web/app/api/razorpay/webhook/route.ts` POST; `web/scripts/razorpay-script-guard.ts` `checkScriptKeys`; `web/lib/credit-purchases.ts` `purchasePaid`, `purchaseRefunded`).

Phase 3 Billing asks Meteroid to issue Paid/pack invoices and creates their Razorpay payment links through `web/lib/billing/razorpay.ts` `ensurePaymentLink`. Its invoice handler validates money, records the payment and marks Meteroid paid; it never calls phase 1's `purchasePaid`. Meteroid grants top-up credits, while staff can still mark bank transfers. These invoice flows/data/fees and their failure gaps belong to [Billing code](billing-code.md#razorpay-collecting-invoice-payments), not this purchase spec (`web/lib/billing/billing.ts` `requestUpgrade`, `buyPacks`; `web/lib/billing/razorpay.ts` `razorpayInvoicePaid`). The flows below describe retained phase 1 behaviour; no enable setting is needed.

### Create or link

From `web/`:

```sh
bun scripts/org-payment-link.ts --org acme --credits 1000 --amount 8000 --currency INR
bun scripts/org-payment-link.ts --org acme --credits 1000 --amount 100 --currency USD \
  --email billing@example.com --contact +14155550100 --name "Acme Inc"
bun scripts/link-invoice.ts --invoice inv_XXXXXXXX --org acme --credits 1000
```

Link creation validates credits, price and currency, creates a local row then requests a Razorpay link (`accept_partial: false`). `reference_id` is the purchase ID; notes include purchaseId/orgId/credits. Payer email/phone enable matching notifications. USD requires both. The ID and URL are saved; no credits are granted until paid. API/save failure attempts local deletion, without cancelling a remote link (`web/lib/credit-purchases.ts` `createPaymentLinkPurchase`; `web/lib/razorpay.ts`).

GST invoices are created in Razorpay Dashboard, not by this API. Linking fetches amount/currency/URL, rejects cancelled/expired/deleted invoices and unsupported currencies, and inserts once (duplicate 409). An already-paid invoice with a payment ID calls `purchasePaid` immediately. Failure applying it leaves the inserted row for reconciliation (`web/lib/credit-purchases.ts` `linkInvoicePurchase`; `web/scripts/link-invoice.ts`).

### Paid purchase

1. Find by Razorpay ID, falling back to supplied purchaseId only if no ID matched. Unknown purchases return null.
2. Require exact amount/currency (422 otherwise), then an `OrgBilling` row (409 otherwise).
3. Claim only status created, storing accepted payment ID, paidAt and Razorpay ID. If already claimed, re-read paymentId: the same payment is a retry, a different payment is 409.
4. POST `/customers/{id}/credit-grants` in Meteroid: `type: PAID`, `credit_unit: MINS`, amount = purchase credits, reason = formatted money and Razorpay ID, reference = paymentId, expiry = now +365 days, `Idempotency-Key: razorpay:<paymentId>`.
5. On grant failure, unclaim only if this attempt claimed it; rethrow so a later delivery can retry. On success schedule org sync and return `{ credits, duplicate }`. Retrying the same payment calls Meteroid with the same key; Meteroid returns the original grant without adding credits again (`web/lib/credit-purchases.ts` `purchasePaid`; `web/lib/meteroid.ts` `grantMinutes`).

### Webhooks and refunds

POST `/api/razorpay/webhook` verifies hex HMAC-SHA256 of the exact raw body using `RAZORPAY_WEBHOOK_SECRET`, comparing equal-length buffers in constant time. A missing signature returns 401 before reading the secret. With a supplied signature, missing `RAZORPAY_WEBHOOK_SECRET` throws; a bad signature with a configured secret returns 401. Verification never bypasses to an off-mode 404. For `payment_link.paid` with `notes.invoiceId`, dispatch goes to the phase 3 invoice handler instead. Otherwise `payment_link.paid` and `invoice.paid` go to phase 1 `purchasePaid`, and `refund.processed` goes to `purchaseRefunded`; others/missing wrappers return ignored 200. Phase 1 notes still use `purchaseId`/`orgId`/`credits`; invoice notes are separate (`web/app/api/razorpay/webhook/route.ts` POST; `web/lib/credit-purchases.ts` `purchasePaid`, `purchaseRefunded`; `web/lib/razorpay.ts` `verifyWebhookSignature`, `env`).

Refunds find the accepted payment's purchase. Unknown payments return null; known refunds log a warning to adjust Meteroid by hand and return `{ refundId, creditsTakenBack: 0 }`. No balance, ledger, refund total or purchase status changes, including on repeat delivery (`web/lib/credit-purchases.ts` `purchaseRefunded`).

Handled events return HTTP 200 `{ ok: true, result }`; unknown purchases return ignored 200. `PurchaseError` is logged and acknowledged as HTTP 200 `{ ok: false, error }`, including an unbilled org. Other errors escape, allowing retries (`web/app/api/razorpay/webhook/route.ts`).

### Reconcile missed payments

```sh
bun scripts/reconcile-purchases.ts                 # report only
bun scripts/reconcile-purchases.ts --apply         # grant missed payments
```

Select created purchases with a Razorpay ID older than `olderThanHours`, oldest first. A paid link needs a captured payment (not merely authorized); a paid invoice needs its payment ID and uses amount_paid. Report or call the same `purchasePaid`. Other purchases report still unpaid. Errors become per-purchase lines and processing continues. `refundDays` is accepted but ignored: reconciliation never reads/applies refunds (`web/lib/credit-purchases.ts` `reconcilePurchases`).

The script defaults to one hour and refund-days 30; validates options; report mode writes nothing and skips the write-key guard. It exits 1 if any result line is an error. Report detection does not validate the payment or guarantee apply will succeed (`web/scripts/reconcile-purchases.ts`; `web/lib/credit-purchases.ts`).

## Rules

1. Credits must be positive integers. Link price must be finite, at least one major currency unit, with at most two decimals. Only INR/USD; USD requires payer email and phone. Invalid library inputs return 400 before creating a purchase (`web/lib/credit-purchases.ts` `checkCredits`, `checkCurrency`, `toSubunits`).
2. Org, Razorpay ID and accepted payment ID enforce ownership/uniqueness. A valid Razorpay-ID match wins over conflicting purchase notes. Only the first payment may claim a purchase; its retries do not reset paidAt (`web/prisma/schema.prisma`; `web/lib/credit-purchases.ts`).
3. Payment money checks happen before requiring billing or claiming. Same-payment concurrency is idempotent at Meteroid's key, not a ledger external ID (`web/lib/credit-purchases.ts` `purchasePaid`).
4. Remote write scripts require `--production` and `rzp_live_` keys; local DBs reject live keys. Report-only reconciliation skips the guard. Meteroid linking has its own key guard; see [Credits](credits.md) (`web/scripts/razorpay-script-guard.ts`; `web/scripts/meteroid-link-org.ts`).
5. No self-serve `CreditPurchase` checkout, saved org price list or refund initiation exists in this module. Self-serve upgrade/packs now redirect to Razorpay in phase 3, but use separate billing-invoice records, not this purchase helper (`web/lib/credit-purchases.ts`; `web/lib/razorpay.ts`; operator scripts above; [Billing code](billing-code.md)).
6. Razorpay is always on for phase 1 and phase 3; `RAZORPAY_ENABLED` cannot disable calls or hide the webhook. API calls require the key pair. The webhook always checks the signature: missing signature is 401; supplied signature without a secret throws; bad signature with a secret is 401 (`web/lib/razorpay.ts` `env`, `call`, `verifyWebhookSignature`; `web/app/api/razorpay/webhook/route.ts` POST; [Billing](billing.md) rule 27).

## Entry points

- Shared POST `/api/razorpay/webhook`: `web/app/api/razorpay/webhook/route.ts` POST; always signature-checked, with no off-mode 404. URL `https://dash.trainertwin.com/api/razorpay/webhook` serves phase 1 events and phase 3 invoice-link payments. Meteroid's separate webhook still supplies invoice/credit events; see [Billing code](billing-code.md).
- Operator scripts listed above; optional note and production flag. Reconciliation also accepts `--older-than`, `--refund-days` (ignored).
- Internal service functions: `web/lib/credit-purchases.ts` `createPaymentLinkPurchase`, `linkInvoicePurchase`, `purchasePaid`, `purchaseRefunded`, `reconcilePurchases`.
- Credits display: `web/lib/minutes-trpc.ts` `minutes.org`, `web/components/credits/credits-page.tsx`; shows Meteroid grants, not purchase lifecycle management.

## Talks to

Razorpay REST uses Basic `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, a 20-second request timeout, POST `/payment_links`, GET `/payment_links/:id` and `/invoices/:id` for phase 1. Missing trimmed keys throw before fetch; otherwise each call makes the external request, regardless of any old `RAZORPAY_ENABLED` value. The same wrapper also supplies phase 3's reference lookup, cancellation, payment/fee and settlement calls; those are documented in [Billing code — Razorpay calls](billing-code.md#razorpay-calls) (`web/lib/razorpay.ts` `env`, `call`, `createPaymentLink`, `fetchPaymentLink`, `fetchInvoice`). The wrapper still exports `fetchRefunds`, but reconciliation no longer calls it (`web/lib/razorpay.ts`; `web/lib/credit-purchases.ts`).

Meteroid uses Bearer API key, PAID MINS grants with stable idempotency keys, and asynchronous org sync. Meteroid 2.2.1 retains expired credits until a usage recount and emits no expiry webhook; the app conservatively subtracts lapsed grants and sends zero-minute recount events. See [Credits](credits.md) (`web/lib/meteroid.ts`; `web/lib/schedule-org-credits.ts`).

## Edge cases and limits

Remote grant and local purchase claim are not one database transaction. Meteroid's key handles retries after a successful grant and local failure. Failed sync scheduling does not undo paid/granted credits. A remote link can remain payable after local save/deletion failure; a later payment may have no purchase to find. Signed malformed JSON/entities can throw; webhook payloads are TypeScript casts, not runtime schemas (`web/lib/credit-purchases.ts`; `web/lib/schedule-org-credits.ts`; `web/app/api/razorpay/webhook/route.ts`).

## Mismatches

- Legacy refund status/total fields remain but are not updated by current refund handling. Script refund-days option remains although it has no effect (`web/prisma/schema.prisma`; `web/scripts/reconcile-purchases.ts`; `web/lib/credit-purchases.ts` `purchaseRefunded`, `reconcilePurchases`).
- Stale switch descriptions outside this edit: [Billing](billing.md)'s introduction still calls phase 1 purchases “off”, `specs/README.md`'s Payments row still mentions the shared switch, and `plans/billing-phase-3.md` still calls PR #15 “switched off today”. Rule 27 and current code agree on always-on Razorpay; these are documentation drift, not a phase 1 code-rule mismatch (`web/lib/razorpay.ts` `call`; `web/app/api/razorpay/webhook/route.ts` POST).

## Open questions

Razorpay enablement is decided: always on, including retained phase 1 purchases ([Billing](billing.md) rules 27, 35; `web/lib/razorpay.ts` `call`; `web/app/api/razorpay/webhook/route.ts` POST). Credential and webhook deployment checks remain in [Billing code — Open questions](billing-code.md#open-questions), not a switch question.

- Refunds do not take credits back; operators must adjust Meteroid manually. When should automatic reversal and refund accounting return? (`web/lib/credit-purchases.ts` `purchaseRefunded`.)
- Credits plan overage is 0.25/min if usage exceeds credits; the app intends not to permit this. Confirm collection policy (`web/scripts/meteroid-setup.ts`).
- Linking checks invoice status/currency, not tax fields. GST classification is the operator's responsibility (`web/lib/razorpay.ts` `RazorpayInvoice`; `web/lib/credit-purchases.ts` `linkInvoicePurchase`).

## Tests today

- Historical run recorded by the previous refresh, **before switch removal**, not rerun here: six billing/Razorpay unit files, **169 pass, 5 fail**. That result does not validate today's always-on behavior; the current request assertions include AbortSignal. Full historical command: [Billing code — Tests today](billing-code.md#tests-today). No phase 1 unit/DB/flow/browser suite was run for this edit.
- Concurrent test updates were read, not run: `web/tests/lib/razorpay.test.ts` now checks missing keys before fetch for links/invoices/link reads/refund reads and missing webhook secret with a supplied signature. `web/tests/flows/billing-razorpay.flow.test.ts` checks that the webhook always verifies signatures, missing secret throws, and phase 1 link/invoice/refund branches still work without an enable setting. The old `web/tests/flows/razorpay-switch.flow.test.ts` is deleted. These sources do not prove deployed credentials or live webhook delivery.
- Unit: `web/tests/lib/credit-purchases.test.ts`, `razorpay.test.ts`, `razorpay-script-guard.test.ts` cover money, signatures, requests and script guards.
- DB: `web/tests/lib/credit-purchases.db.test.ts`, `org-credits-purchase-retry.db.test.ts` cover Meteroid grant body/key, one-year expiry, unbilled refusal, unclaim/retry, money mismatch, invoices, logged refunds and same-payment concurrency.
- Flows: `web/tests/flows/credit-purchases.flow.test.ts`, `credits-purchase-practice.flow.test.ts`, `reconcile-purchases.flow.test.ts`, `reconcile-purchases-script.flow.test.ts` cover signed events, invoices, currency, grants, practice, refund preservation and missed payments. MSW fakes Meteroid/Razorpay (`harness.ts`; `web/tests/setup/meteroid.ts`).
- Browser: `web/e2e/payments.spec.ts` checks paid/retry/log-only refund/forged signature and displayed grants against the local fake (`web/e2e/meteroid.ts`), not actual checkout.
