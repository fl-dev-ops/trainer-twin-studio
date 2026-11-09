# Payments

> TrainerTwin staff sell an organization prepaid practice credits through Razorpay, at a price agreed for that purchase. Staff create a payment link or link an invoice made in the Razorpay Dashboard. A signed webhook adds the credits after payment and takes back the refunded share. A reconciliation script catches missed webhooks. Credit balances and learner spending belong to [Credits](credits.md). (`web/lib/credit-purchases.ts`; `web/scripts/reconcile-purchases.ts`.)

## Who uses it

| Who | What they do here | Code |
| --- | --- | --- |
| TrainerTwin staff with shell, database and Razorpay access | Create payment links, link Dashboard invoices, report or apply missing payments/refunds. These are operator scripts, not org-role-checked procedures. | `web/scripts/org-payment-link.ts`, `web/scripts/link-invoice.ts`, `web/scripts/reconcile-purchases.ts` |
| Payer | Pays the agreed amount on Razorpay's hosted link or invoice. May receive email/SMS from Razorpay. | `web/lib/razorpay.ts` `createPaymentLink`; `web/lib/credit-purchases.ts` `linkInvoicePurchase` |
| Org admin / team | See the resulting balance and ledger history in the studio; cannot create purchases there. | `web/components/credits/credits-page.tsx`; `web/lib/minutes-trpc.ts` `minutesRouter` |
| Razorpay | Sends signed payment/refund events; no TrainerTwin user session is required. API paths pass through the host proxy. | `web/app/api/razorpay/webhook/route.ts` POST; `web/proxy.ts` `isPassthrough` |

## Words used here

| Term | Meaning |
| --- | --- |
| Credit | One minute of practice. Payments add whole credits to the org, not directly to learners. (`web/lib/minutes-trpc.ts` module comment; `web/lib/credit-purchases.ts` `purchasePaid`.) |
| Purchase (`CreditPurchase`) | One org's agreed credits, money amount and currency, tied to one Razorpay payment link or invoice. (`web/prisma/schema.prisma` `CreditPurchase`.) |
| Payment link | A hosted Razorpay payment page created by the script; its ID is stored as `razorpayId` (`plink_…`). (`web/lib/razorpay.ts` `createPaymentLink`; `web/lib/credit-purchases.ts` `createPaymentLinkPurchase`.) |
| GST invoice | A tax invoice made in the Razorpay Dashboard, then linked to a purchase by its `inv_…` ID. The code states that Razorpay's API cannot create GST invoices. (`web/scripts/org-payment-link.ts` header; `web/scripts/link-invoice.ts`.) |
| Subunit | Smallest money unit: paise for INR, cents for USD. ₹8,000 is stored as `800000`; $99.50 as `9950`. (`web/lib/credit-purchases.ts` `toSubunits`; `web/prisma/schema.prisma` `CreditPurchase.amount`.) |
| Payment / refund ID | Razorpay's `pay_…` / `rfnd_…` identifier. A payment buys the credits; each processed refund takes a share back. (`web/prisma/schema.prisma` `paymentId`, `MinuteLedger.externalId`.) |
| Ledger (`MinuteLedger`) | The credits module's append-only balance movements, stored in seconds. A purchase writes a positive `topup`; a refund writes a negative `refund`. (`web/lib/minutes.ts` `orgMovement`; see [Credits](credits.md).) |
| Webhook | Razorpay's HTTP notification, authenticated using a signature over its exact raw body. (`web/app/api/razorpay/webhook/route.ts` POST; `web/lib/razorpay.ts` `verifyWebhookSignature`.) |
| Reconciliation | Reading Razorpay's current state and reporting or applying missing ledger movements. (`web/lib/credit-purchases.ts` `reconcilePurchases`.) |

## Data

### Purchase record

`CreditPurchase` is defined in `web/prisma/schema.prisma`. SQL constraints and indexes live in `web/prisma/migrations/20261109120000_credit_purchases/migration.sql`; Prisma does not track its CHECK constraints.

| Fields | Meaning / allowed values | Writer |
| --- | --- | --- |
| `id`, `orgId` | Generated purchase ID; owning organization. Org deletion cascades to purchases. | `createPaymentLinkPurchase`, `linkInvoicePurchase` in `web/lib/credit-purchases.ts`; schema relation |
| `credits` | Positive integer credits bought. | Both creation functions |
| `amount`, `currency` | Positive integer subunits; `INR` or `USD`. | Link creation converts the supplied price; invoice linking copies Razorpay's amount/currency |
| `kind` | `payment_link` or `invoice`. | Both creation functions |
| `razorpayId` | Unique, nullable link/invoice ID; initially null during link creation. | Creation functions; `purchasePaid` also stores the incoming ID |
| `url` | Nullable hosted payment/invoice URL. | Creation functions |
| `paymentId` | Unique, nullable ID of the payment accepted for this purchase. | `purchasePaid` |
| `status` | `created` by default; also `paid`, `partially_refunded`, `refunded`. | Creation functions, `purchasePaid`, `purchaseRefunded` |
| `refundedAmount` | Recorded cumulative refunded subunits, initially 0; SQL requires `0 <= refundedAmount <= amount`. Tiny refunds can be omitted; see limits below. | `purchaseRefunded` |
| `note` | Optional operator note on the purchase; not the same as the generated ledger note. | Creation functions |
| `createdAt`, `paidAt` | Creation time; nullable time TrainerTwin applies the payment, not the Razorpay payment timestamp. | DB default; `purchasePaid` |

Writers in this table are functions in `web/lib/credit-purchases.ts`. The database permits the listed status values but does not enforce transitions between them; the application does.

Lifecycle (`web/lib/credit-purchases.ts`):

- `created → paid`: exact matching payment, with the top-up in the same transaction.
- `paid → partially_refunded → refunded`: recorded partial refunds followed by enough money to reach the original amount; more partial refunds can keep `partially_refunded`.
- `paid → refunded`: a recorded full refund in one step.
- There is no `failed`, `cancelled` or `expired` purchase state. Failed link creation attempts delete their local row on a best-effort basis. An unpaid remote link/invoice does not change the local status during reconciliation.

### Ledger boundary

Payments do not own a separate balance. `purchasePaid` calls `topUpOrg` with `externalId = paymentId`; `purchaseRefunded` calls `refundOrg` with `externalId = refundId`. The credits module converts credits to signed seconds, writes an org-owned row (`email = null`) and updates the purchase through an `alongside` callback in the same locked transaction. `MinuteLedger.externalId` is globally unique; refund rows require it. (`web/lib/minutes.ts` `orgMovement`, `locked`; migration above.) See [Credits](credits.md) for balance calculation, grants and usage.

## How it works

### Required setup

1. Apply the credit-purchase migration, including the ledger `externalId` index and CHECK constraints. (`web/prisma/migrations/20261109120000_credit_purchases/migration.sql`.)
2. Set `DATABASE_URL` for the intended database and `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` for the intended Razorpay account/mode. REST calls use Basic authentication against `https://api.razorpay.com/v1`; missing or blank API keys throw before fetching. Use test keys locally and live keys in production. (`web/lib/razorpay.ts` `env`, `call`; `web/scripts/razorpay-script-guard.ts`.)
3. Configure Razorpay Dashboard → Webhooks with `https://dash.trainertwin.com/api/razorpay/webhook`, subscribing to `payment_link.paid`, `invoice.paid`, `refund.processed`. Set `RAZORPAY_WEBHOOK_SECRET` to the secret configured there; it is separate from the API key secret. The three key names are documented in `web/.env.example`. (`web/app/api/razorpay/webhook/route.ts` header; `web/lib/razorpay.ts` `verifyWebhookSignature`.)
4. For USD links, enable International Payments on the Razorpay account and supply payer email and phone. The code checks that both are present, not that the account setting is enabled. (`web/scripts/org-payment-link.ts` header; `web/lib/credit-purchases.ts` `createPaymentLinkPurchase`.)

### Create a payment link

Run from `web/`, for example:

```sh
bun scripts/org-payment-link.ts --org acme --credits 1000 --amount 8000 --currency INR
bun scripts/org-payment-link.ts --org acme --credits 1000 --amount 100 --currency USD \
  --email billing@example.com --contact +14155550100 --name "Acme Inc"
```

1. The script requires org slug, credits, price and currency, uppercases currency, checks environment safety, and refuses an unknown org. Optional `--note` stays on the purchase. (`web/scripts/org-payment-link.ts`.)
2. The library validates credits, currency, amount and USD payer requirements before creating a row. Amount is supplied in major units, then converted to subunits. (`web/lib/credit-purchases.ts` `createPaymentLinkPurchase`, `toSubunits`.)
3. It creates the `created` row first, then requests a Razorpay link with `accept_partial: false`. `reference_id` is the purchase ID; notes carry `purchaseId`, `orgId` and credits as a string. When email or phone exists it sends customer details and enables only the corresponding email/SMS notifications. A name alone is not sent. (`web/lib/credit-purchases.ts` `createPaymentLinkPurchase`; `web/lib/razorpay.ts` `createPaymentLink`.)
4. It saves the link ID and short URL and prints the price, URL and IDs. No credits are added yet. If the API call or saving its result fails, it attempts to delete the purchase, suppresses deletion errors and rethrows the original error. There is no remote-link cancellation in this cleanup. (`web/lib/credit-purchases.ts` `createPaymentLinkPurchase`; `web/scripts/org-payment-link.ts`.)

### Link a Dashboard GST invoice

Run from `web/` after making the invoice in Razorpay Dashboard:

```sh
bun scripts/link-invoice.ts --invoice inv_XXXXXXXX --org acme --credits 1000
```

1. The script checks required arguments, environment safety and org existence. (`web/scripts/link-invoice.ts`.)
2. `linkInvoicePurchase` validates credits and fetches the invoice. It rejects `cancelled`, `expired`, `deleted`, or an unsupported currency before inserting a row. It copies the fetched amount, currency, ID and URL, not an operator-supplied price. (`web/lib/credit-purchases.ts` `linkInvoicePurchase`; `web/lib/razorpay.ts` `fetchInvoice`.)
3. Linking an already-linked invoice raises `PurchaseError` 409 through the unique constraint. An invoice with status `paid` and a `payment_id` immediately goes through `purchasePaid`; otherwise credits wait for the webhook or reconciliation. (`web/lib/credit-purchases.ts` `linkInvoicePurchase`.)
4. Fetch failure creates no row. Failure while applying an already-paid invoice leaves the inserted purchase in place; insertion and crediting are not one transaction. The linking code does not fetch tax details or verify that the invoice is actually a GST invoice. (`web/lib/credit-purchases.ts` `linkInvoicePurchase`; `web/lib/razorpay.ts` `RazorpayInvoice`.)

### Receive payment and refund events

1. POST reads the raw body and checks `x-razorpay-signature` before JSON parsing or purchase writes. Missing/wrong signatures return HTTP 401 with `{ error: "Invalid signature" }`. The signature is a hex HMAC-SHA256 using the webhook secret; equal-length buffers are compared with `timingSafeEqual`. (`web/app/api/razorpay/webhook/route.ts` POST; `web/lib/razorpay.ts` `verifyWebhookSignature`.)
2. The route dispatches only the following events when their required entity wrappers are present. (`web/app/api/razorpay/webhook/route.ts` POST.)

| Event | Required entities | Action |
| --- | --- | --- |
| `payment_link.paid` | `payment_link`, `payment` | `purchasePaid` with link ID, optional `notes.purchaseId`, payment ID, payment amount/currency |
| `invoice.paid` | `invoice`, `payment` | `purchasePaid` with invoice ID and payment details |
| `refund.processed` | `refund` | `purchaseRefunded` with refund ID, payment ID, refund amount/currency |
| Anything else, including `payment.authorized`, `payment.captured`, failure/cancellation events, or missing wrappers | — | HTTP 200 `{ ok: true, ignored: eventName }`; absent event becomes `"unknown"` |

3. `purchasePaid` first looks up `razorpayId`, then falls back to the supplied purchase ID only if no ID match exists. That fallback handles a fast webhook arriving before link creation stores its Razorpay ID. No purchase means HTTP 200 `{ ok: true, ignored: "not a credit purchase" }`. (`web/lib/credit-purchases.ts` `purchasePaid`; webhook POST.)
4. A payment must match the stored amount and currency exactly. `topUpOrg` then writes the ledger row and marks only a `created` purchase as `paid`, setting `paymentId`, `paidAt` and `razorpayId`. A repeated payment ID skips both writes. A different second payment causes the status update to fail and rolls back its top-up. (`web/lib/credit-purchases.ts` `purchasePaid`; `web/lib/minutes.ts` `orgMovement`.)
5. Refunds find the purchase by its accepted `paymentId`; unknown payments are ignored. Matching currency is required. For recorded refunds, the negative ledger row and cumulative refund/status update commit together. See the refund formula and shortcuts below. (`web/lib/credit-purchases.ts` `purchaseRefunded`; `web/lib/minutes.ts` `refundOrg`.)
6. Successful handled events return HTTP 200 `{ ok: true, result }`. A `PurchaseError` is logged and returned as HTTP 200 `{ ok: false, error }`, even when its internal status is 409 or 422: retrying cannot fix a second payment or mismatch. Other errors escape to the framework rather than being acknowledged as successful. (`web/app/api/razorpay/webhook/route.ts` POST.)

### Reconcile missed webhooks

Run from `web/`:

```sh
bun scripts/reconcile-purchases.ts                 # report only
bun scripts/reconcile-purchases.ts --apply         # write missing movements
bun scripts/reconcile-purchases.ts --apply --production --older-than 1 --refund-days 30
```

1. Defaults are `--older-than 1` hour and `--refund-days 30` days. The first must be nonnegative, the second positive; missing option values or `NaN` are refused. Only `--apply` runs the write-key guard. (`web/scripts/reconcile-purchases.ts`.)
2. Select `created` purchases with non-null `razorpayId` created strictly before the age cutoff, oldest first. For links, fetch current state and select the first `captured` payment only when the link is `paid`. For invoices, require status `paid` and a payment ID, and use `amount_paid`. Otherwise report `still unpaid`. (`web/lib/credit-purchases.ts` `reconcilePurchases`; `web/lib/razorpay.ts` `fetchPaymentLink`, `fetchInvoice`.)
3. Report a detected payment, or apply it through `purchasePaid`. Then select `paid` / `partially_refunded` purchases with a payment ID and `paidAt` strictly newer than the refund cutoff. Fetch their refunds, keep only `processed` ones, and exclude refund IDs already in the ledger. Report each remaining refund, or apply it through `purchaseRefunded`. Thus apply mode can catch a payment and its refund in one run. (`web/lib/credit-purchases.ts` `reconcilePurchases`.)
4. Errors become per-purchase `error` lines and do not stop later purchases. A refund error stops the remaining refunds for that purchase in that run. The script prints mode, count, org, IDs, action and detail, disconnects, and exits 1 if any line is an error. (`web/lib/credit-purchases.ts` `reconcilePurchases`; `web/scripts/reconcile-purchases.ts`.)
5. Report mode writes nothing and does not run the payment/refund validation functions: “would add credits” is detection, not proof that apply will pass amount/currency checks. Apply uses the same ledger idempotency as webhooks, so late duplicate events do not add a second movement. (`web/lib/credit-purchases.ts` `reconcilePurchases`, `purchasePaid`, `purchaseRefunded`.)

## Rules

1. Only `INR` and `USD` purchases are supported. Credits must be an integer of at least 1. Payment-link price must be finite, at least 1 major currency unit, and have at most two decimals (conversion tolerance `1e-6` subunits). Library violations raise `PurchaseError` 400 before creating a row. Invoice amounts come from Razorpay and must pass the DB's positive-integer constraint. (`web/lib/credit-purchases.ts` `checkCredits`, `checkCurrency`, `toSubunits`, creation functions; credit-purchase migration.)
2. USD payment links require truthy payer email and phone; INR allows neither. The library does not validate their formats. New payment links always send `accept_partial: false`; there is no partial-payment top-up. (`web/lib/credit-purchases.ts` `createPaymentLinkPurchase`; `web/lib/razorpay.ts` `createPaymentLink`.)
3. Purchases must reference an existing org; invoice/link IDs and accepted payment IDs are unique across orgs. The existing Razorpay-ID match takes precedence over a conflicting purchase ID in notes. (`web/prisma/schema.prisma` `CreditPurchase`; migration; `web/lib/credit-purchases.ts` `purchasePaid`.)
4. Amount or currency mismatch on payment raises internal status 422 and changes neither purchase nor ledger. Refund currency mismatch also raises 422 before writes. Webhooks acknowledge these errors with HTTP 200 and log them. (`web/lib/credit-purchases.ts` `purchasePaid`, `purchaseRefunded`; webhook POST.)
5. Exactly-once ledger movement is keyed by Razorpay payment/refund ID, not webhook delivery ID. Under the org lock, an existing `externalId` returns `duplicate: true` without writing or running `alongside`. The unique index is a second safeguard. This covers recorded movements; zero-credit refunds bypass the ledger entirely. (`web/lib/minutes.ts` `locked`, `orgMovement`; migration; `web/lib/credit-purchases.ts` `purchaseRefunded`.)
6. A purchase can accept only its first payment. A different payment ID after it leaves `created` raises internal status 409 and rolls back the new ledger row. A duplicate of the original matching payment does not reset its state, even after refunds. (`web/lib/credit-purchases.ts` `purchasePaid`; `web/lib/minutes.ts` `orgMovement`.)
7. Refund credit removal uses cumulative rounding. With `C = credits`, `A = original amount`, `R = stored refundedAmount`, `r = incoming refund amount`: `newR = min(A, R + r)`; credits to remove = `round(C × newR / A) − round(C × R / A)`. Recorded refunds set `refundedAmount = newR` and status `refunded` when `newR >= A`, otherwise `partially_refunded`. For 100 credits bought for ₹1,000, sequential ₹333 and ₹667 refunds remove 33 and 67 credits. (`web/lib/credit-purchases.ts` `purchaseRefunded`; `web/tests/lib/credit-purchases.db.test.ts` cumulative-rounding test.)
8. If that computed removal is less than 1 credit, return `{ orgBalanceMinutes: null, duplicate: false, credits: 0 }` with no ledger row, money update or status update. This also happens on delivery after the purchase is fully refunded. (`web/lib/credit-purchases.ts` `purchaseRefunded`.)
9. Refunds debit the org even below zero. They do not reclaim learners' existing credits. Further grants must fit the remaining org balance; later top-ups can clear the debt. (`web/lib/minutes.ts` `refundOrg`, `orgMovement`, `grantMinutes`; see [Credits](credits.md).)
10. Payment-link creation, invoice linking and reconciliation with `--apply` require `--production` and a key ID starting `rzp_live_` against any non-local DB. Local hosts are exactly `localhost`, `127.0.0.1`, `::1`, `[::1]`; missing/invalid URLs count as remote. Local databases reject live-prefixed keys even with `--production`. The guard checks host and key prefix, not key validity or account identity. Reconciliation report mode skips this guard but REST reads still need API credentials. (`web/scripts/razorpay-script-guard.ts` `isRemoteDatabase`, `checkScriptKeys`; three operator scripts; `web/lib/razorpay.ts` `call`.)
11. There is no self-serve purchase creation/checkout in TrainerTwin, saved per-org price list, or subscription billing. Each operator command supplies that purchase's credits and price (or invoice); the schema has only `payment_link` / `invoice` kinds. Payers use Razorpay's hosted checkout, not an app checkout. (`web/scripts/org-payment-link.ts`; `web/scripts/link-invoice.ts`; `web/prisma/schema.prisma` `CreditPurchase`; `web/lib/minutes-trpc.ts` `minutesRouter`; `web/components/credits/credits-page.tsx`.)

## Entry points

| Entry | Path / purpose |
| --- | --- |
| POST `/api/razorpay/webhook` | `web/app/api/razorpay/webhook/route.ts`: signature-authenticated payment/refund notifications. Configured production URL is listed above. |
| `bun scripts/org-payment-link.ts` | `web/scripts/org-payment-link.ts`: `--org`, `--credits`, `--amount`, `--currency`; optional `--email`, `--contact`, `--name`, `--note`, `--production`. |
| `bun scripts/link-invoice.ts` | `web/scripts/link-invoice.ts`: `--invoice`, `--org`, `--credits`; optional `--note`, `--production`. |
| `bun scripts/reconcile-purchases.ts` | `web/scripts/reconcile-purchases.ts`: report by default; optional `--apply`, `--older-than`, `--refund-days`, `--production`. No scheduled reconciliation is defined by this script. |
| Internal service functions | `web/lib/credit-purchases.ts`: `createPaymentLinkPurchase`, `linkInvoicePurchase`, `purchasePaid`, `purchaseRefunded`, `reconcilePurchases`. Not exposed as purchase-creation tRPC procedures. |
| Studio credits display | `/credits` on the dash host, `web/components/credits/credits-page.tsx`, `credits-history-table.tsx`; `web/lib/minutes-trpc.ts` `minutes.org`. Shows ledger outcomes, not purchase lifecycle management; see [Credits](credits.md). |
| Notifications | Razorpay email/SMS requested by `web/lib/razorpay.ts` `createPaymentLink`. This flow does not call TrainerTwin's email service. |

## Talks to

- **Razorpay REST API:** Basic-authenticated POST `/payment_links`, GET `/payment_links/:id`, GET `/invoices/:id`, GET `/payments/:paymentId/refunds`. Outgoing data includes the agreed amount/currency, credit description, purchase/org IDs and optional payer details; responses provide IDs, URLs and payment/refund state. HTTP failures throw `RazorpayError` with the remote status and description (or status text). (`web/lib/razorpay.ts` `call`, exported REST functions.)
- **Razorpay Dashboard:** Staff create GST invoices and configure webhook events/secrets and International Payments. The app links invoices; it does not create GST invoices or initiate refunds. Its REST wrapper has no refund-creation operation. (`web/scripts/org-payment-link.ts` header; `web/scripts/link-invoice.ts`; `web/app/api/razorpay/webhook/route.ts` header; `web/lib/razorpay.ts`.)
- **Credits / PostgreSQL:** Payments hand whole credits, a descriptive money/ID note and an external ID to the ledger service, plus an atomic purchase-update callback. The service returns current org balance in minutes and a duplicate flag; refunds also return computed credits. Ledger/history display uses these signed movements, not a separate purchase balance. (`web/lib/credit-purchases.ts` `purchasePaid`, `purchaseRefunded`; `web/lib/minutes.ts` `orgMovement`, `creditsAdded`, `orgCreditsAddedSeconds`; see [Credits](credits.md).)

## Edge cases and limits

- **Tiny refunds are lost, not accumulated.** A refund rounding below one credit updates neither `refundedAmount` nor its external ID. Repeated tiny refunds therefore need not add up locally, and reconciliation can keep reporting them as unseen. (`web/lib/credit-purchases.ts` `purchaseRefunded` shortcut, `reconcilePurchases`; DB test “documented shortcut”.)
- **Concurrent different refunds:** the share and money total are computed before taking the org lock. The source shortcut assumes Razorpay sends a payment's refunds one at a time and warns of a one-credit rounding discrepancy. Two stale reads can also each overwrite `refundedAmount` from the same old total; the lock protects ledger writes but does not recompute the purchase share. (`web/lib/credit-purchases.ts` `purchaseRefunded`; `web/lib/minutes.ts` `orgMovement`.)
- **Refund amounts are trusted beyond currency matching.** The handler caps the cumulative amount at the purchase amount; it does not explicitly reject zero, negative, non-integer or oversized incoming refund amounts. A result below one credit is simply skipped. Entity shapes are TypeScript casts, not runtime schema validation. (`web/lib/credit-purchases.ts` `purchaseRefunded`; webhook `Event` and POST.)
- **Signed malformed input:** JSON parsing happens outside the route's `try`; malformed JSON throws. Missing event wrappers can be acknowledged as ignored, while malformed inner entities can throw. Missing webhook secret throws when a signature is supplied; it is not converted to a 401 response. (`web/app/api/razorpay/webhook/route.ts` POST; `web/lib/razorpay.ts` `verifyWebhookSignature`, `env`.)
- **Unpaid forever:** cancellation/expiry/failure events do not update purchases. Reconciliation keeps cancelled/expired remote purchases locally `created` and reports them as still unpaid. It skips purchases with null `razorpayId`. (`web/app/api/razorpay/webhook/route.ts` POST; `web/lib/credit-purchases.ts` `reconcilePurchases`.)
- **Bounded recovery:** reconciliation skips fully refunded purchases and refunds for purchases whose local `paidAt` is outside the selected window. `fetchRefunds` makes one request and has no pagination loop; reconciliation processes refunds in the returned order. Its output says “credits taken back” after an apply call even if that call removed zero credits or was a duplicate. (`web/lib/razorpay.ts` `fetchRefunds`; `web/lib/credit-purchases.ts` `reconcilePurchases`.)
- **Creation failure window:** creating the remote link and saving its ID are not atomic. A failed save can leave a payable remote link after the local deletion attempt. Cleanup does not cancel the link; a later payment may have no purchase to find. (`web/lib/credit-purchases.ts` `createPaymentLinkPurchase`.)

## Mismatches

- `web/lib/credit-purchases.ts` `purchaseRefunded` describes taking back the refunded share “once per refund”, and the webhook header describes each refund happening once. The zero-credit shortcut deliberately records neither the refund nor its money, so this promise applies only to ledger-recorded refunds. The function's shortcut comment and `web/tests/lib/credit-purchases.db.test.ts` explicitly document that exception.
- The refund-concurrency shortcut comment in `web/lib/credit-purchases.ts` warns only of rounding by a credit. The pre-lock read followed by an absolute `refundedAmount` update can also lose a cumulative money update when different refunds overlap (`purchaseRefunded`; `web/lib/minutes.ts` `locked`, `orgMovement`). This is not fixed by ledger external-ID uniqueness.
- No payments-specific disagreement was found in `PRODUCT.md` or the current `plans/*.md`; neither defines a payment flow. The migration's header mentions “plans: payments”, but no `plans/payments.md` exists in this checkout. This spec follows the current branch's implementation, not an assumed missing plan. (`PRODUCT.md`; `plans/`; `web/prisma/migrations/20261109120000_credit_purchases/migration.sql`.)

## Open questions

- Does the one-at-a-time refund assumption also hold when reconciliation and live webhooks overlap? The sequential loop in `reconcilePurchases` cannot prevent a live `purchaseRefunded` call from reading the same old refund total. (`web/lib/credit-purchases.ts` refund shortcut and both functions; `web/lib/minutes.ts` org lock.)
- Should linking validate that an invoice is really a GST invoice? The script calls itself a GST-invoice linker, but the fetched type and checks contain only ID, status, money, URL and payment ID, with no tax fields. Today that classification is the operator's responsibility. (`web/scripts/link-invoice.ts` header; `web/lib/razorpay.ts` `RazorpayInvoice`; `web/lib/credit-purchases.ts` `linkInvoicePurchase`.)

## Tests today

| Layer | Files | Coverage |
| --- | --- | --- |
| Unit | `web/tests/lib/credit-purchases.test.ts` | Subunit conversion, minimum/decimal validation, INR/USD money formatting. |
| Unit | `web/tests/lib/razorpay.test.ts` | Exact raw-body signature, missing/wrong secrets/signatures, Basic auth, link request/notification shape, encoded invoice IDs, API errors and missing credentials. Fetch is stubbed. |
| Unit | `web/tests/lib/razorpay-script-guard.test.ts` | Remote hosts require explicit production approval/live prefix; local hosts reject live keys. |
| DB | `web/tests/lib/credit-purchases.db.test.ts` | Creation, already-paid/unpaid invoices, duplicate invoice, mismatches, second payment rollback, purchase-ID fallback, sequential refund rounding, tiny-refund shortcut, negative org balance without learner reclaim, signature rejection/ignored events, org isolation, concurrent identical payments, ledger atomicity and SQL constraints. |
| Flows | `web/tests/flows/credit-purchases.flow.test.ts` | Dashboard invoices, USD payer requirements and currency match/history, refunds causing debt and refusing invites/API assignments, recovery top-up, forged/repeated/concurrent paid deliveries. |
| Flows | `web/tests/flows/credits-purchase-practice.flow.test.ts` | Payment → assignment → practice → partial refund across module boundaries. |
| Flows | `web/tests/flows/reconcile-purchases.flow.test.ts` | Lost payment/refund webhooks, report without writes, apply/late duplicates, age/refund windows, invoice recovery, captured vs authorized payments, pending refunds, per-purchase errors and continuation. |
| Flows / subprocess | `web/tests/flows/reconcile-purchases-script.flow.test.ts`; `web/tests/flows/fixtures/reconcile-razorpay.ts` | Script argument errors, report-mode no writes/guard bypass, apply production guard and exit 1 on simulated API failure. |
| Browser | `web/e2e/payments.spec.ts`; seed in `web/e2e/seed.ts` | Signed paid event, duplicate, partial refund and forged signature; balance and positive/negative history visible after reload. Does not exercise Razorpay's actual checkout. |

DB/flow tests run only with a local real database (`web/tests/lib/minutes-test-db.ts`); preload redirects to a local `_test` database (`web/tests/setup/preload.ts`, `test-db-url.ts`). Flow HTTP services are faked by `web/tests/flows/harness.ts`; the reconciliation subprocess fixture fails closed instead of reaching Razorpay.

Important gaps: concurrent different refunds and webhook/reconciliation overlap; orphaned remote links after DB-save failure; malformed signed entity bodies; live Razorpay GST/International Payments configuration and real hosted checkout. These paths/settings have no assertions in the listed payment tests. No Python payment tests apply: payment handling lives in the web service (`web/lib/credit-purchases.ts`; webhook POST).
