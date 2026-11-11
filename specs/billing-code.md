# Billing code

> Phase 2 billing links an org to Meteroid invoices, a Paid subscription and minute packs. Staff record bank payments in Meteroid; the app keeps invoice copies, sends invoices and receipts, and blocks new voice calls and learner grants while paused. This is a **module spec**, describing the code, not the agreed rules in [Billing](billing.md). Owners: `web/lib/billing/billing.ts`, `web/lib/billing/meteroid.ts` and the two invoice workflows. [Credits](credits.md) owns balances and spending; [Payments](payments.md) describes the switched-off phase 1 Razorpay path.

## Who uses it

| Actor | What the code allows / pointer |
| --- | --- |
| Org admin / team | Read Billing, save details, request an upgrade, buy packs and download their org's PDFs (`web/lib/billing/trpc.ts` `billingRouter`; PDF routes below). |
| Learner | No billing procedures or PDF access (403). New voice calls are refused while paused; resumed live calls continue (`web/lib/trpc.ts` `studioProcedure`; `web/lib/interview-sessions.ts` `activateSession`). |
| TrainerTwin staff | Set the next-upgrade price with `web/scripts/billing-price.ts`; configure a tenant with `meteroid-billing-setup.ts`; reapply saved customer details/tax wording with `billing-sync-customers.ts`; check invariants with `check-billing.ts`. Staff mark paid and change/cancel existing subscriptions in Meteroid, not the Billing UI. |
| Meteroid | Issues invoices, renews subscriptions, supplies PDFs, records payment, grants paid top-up credits and sends signed events (`web/lib/billing/meteroid.ts` `createPaidSubscription`, `createPackInvoice`; webhook POST). |
| Workflow / cron | Run invoice steps and repair copies/effects left behind (`web/workflows/invoice-issued.ts` `invoiceIssued`; `invoice-paid.ts` `invoicePaid`; `web/lib/billing/billing.ts` `checkAllBilling`). |

## Words used here

| Term | Meaning / pointer |
| --- | --- |
| Billed org | An org with `OrgBilling`, linked to one Meteroid customer (`web/prisma/schema.prisma` `OrgBilling`). |
| Trial / Paid | App plan strings `trial` / `paid`. Trial retains the existing free Credits metering subscription. Paid adds a separate Paid subscription (`web/lib/org-billing-setup.ts` `linkOrgToMeteroid`; `web/lib/billing/billing.ts` `requestUpgrade`, `invoicePaid`). |
| Pending upgrade | Trial with a non-null `paidSubscriptionId`; payment has not yet activated the app plan (`billingOverview`). |
| Pack / credit | 100 minutes for a nominal $25, tax included. Meteroid's credit unit is `MINS`, one credit per minute (`web/lib/billing/pricing.ts` constants; `web/lib/meteroid.ts` `CREDIT_UNIT`). |
| Invoice kind | `upgrade`: a current Paid subscription's invoice first seen while Trial; `renewal`: first seen while Paid; `pack`: subscription-free ONE_OFF with a `Purchase credits` line; otherwise `other` (`billing.ts` `kindOf`; `meteroid.ts` `toInvoice`). |
| Due / overdue | Due through the due-date UTC day; overdue from 00:00 UTC the following day. Overdue is a view, not a stored status (`billing.ts` `overdueFrom`, `billingOverview`). |
| Paused | Non-null `OrgBilling.pausedAt`; new calls/grants use this local flag (`web/lib/billing/paused.ts` `pausedReason`). |
| Receipt | App-generated payment PDF, separate from Meteroid's tax invoice (`web/lib/billing/receipt.ts` `renderReceipt`). |
| Claim | Atomic null-to-timestamp update of `issuedRunAt` or `paidRunAt` before starting a workflow (`billing.ts` `claim`). |
| Net / gross / basis points | Before tax / tax included / hundredths of one percent (900 = 9%). Pack net prices account for each tax's rounding (`pricing.ts` `packPrice`, `totalWithTax`; `details.ts` `TaxLine`). |

## Data

### Org billing

`web/prisma/schema.prisma` `OrgBilling` owns both credit cache and billing state. Credit cache fields are described in [Credits](credits.md#data).

| Billing fields | Values and writers |
| --- | --- |
| `orgId`, `meteroidCustomerId` | Primary org ID, unique customer ID. Provisioning writes them (`web/lib/org-billing-setup.ts` `linkOrgToMeteroid`). |
| `plan` | String, defaults to `trial`; `invoicePaid` sets `paid`, `paidSubscriptionEnded` sets `trial`. |
| `paidSubscriptionId` | Nullable, unique. Set by `requestUpgrade`, early-webhook recognition in `kindOf`, or lost-ID adoption in `invoicePaid`; cleared by overdue-upgrade cancellation / `paidSubscriptionEnded`. |
| `paidMonthlyCents` | Nullable custom tax-inclusive USD monthly price; null displays $300 and uses Meteroid's plan price. `web/scripts/billing-price.ts` writes only this app field. Existing Paid subscriptions require a separate Meteroid price edit. |
| `pausedAt` | Nullable timestamp. `pauseFor` sets it only for the current subscription of an unpaused Paid org; renewal `invoicePaid` and `syncOrgInvoices` clear it when no current-subscription renewal copy is overdue unpaid; `paidSubscriptionEnded` always clears it. |
| `billingDetails` | Nullable JSON: `legalName`, `country`, `line1`, optional `line2`, `city`, `postalCode`, India-only `state` GST code, optional `taxId`, `emails`. `saveBillingDetails` writes validated details after the Meteroid patch. |

The migration `web/prisma/migrations/20261112120000_billing_phase2/migration.sql` adds these fields; existing rows become Trial, without changing Meteroid subscriptions. SQL checks allow only trial/paid, positive-or-null custom cents, and a pause only on Paid. SQL does **not** require a Paid subscription ID or an overdue invoice; the check script checks those separately. Deleting the organization cascades billing and invoices (`OrgBilling`, `BillingInvoice` schema relations).

### Invoice copy

`web/prisma/schema.prisma` `BillingInvoice`; writers below are in `web/lib/billing/billing.ts`.

| Fields | Meaning / writer |
| --- | --- |
| `id`, `orgId`, `number` | Meteroid invoice ID (primary key), billed org FK, invoice number. `recordInvoice` creates the copy; invoice numbers are not DB-unique. |
| `kind`, `status` | Kind above; stored status `unpaid`, `paid` or `void`. Kind stays fixed once created. `recordInvoice`, `invoiceVoided`, `invoiceOverdue` update status. |
| `totalCents`, `taxCents`, `currency`, `credits`, `subscriptionId` | Meteroid total/tax/currency, pack credits (0 otherwise), nullable subscription ID (`recordInvoice`). |
| `issuedAt`, `dueDate`, `periodStart`, `periodEnd`, `paidAt`, `paymentRefs` | Issue timestamp; UTC date-only due/period fields; nullable paid timestamp; settled non-refund payment references (`recordInvoice`; `meteroid.ts` `toInvoice`). Missing paid time falls back to previous paid time or now. |
| `issuedRunAt`, `paidRunAt` | Workflow claims. `claim` sets them; a failed start resets that claim. They are not workflow run IDs. |
| `issuedEmailAt`, `reminderAt`, `overdueEmailAt`, `paidEmailAt` | Email completion markers (`emailOnce`). Paused and upgrade-cancelled share `overdueEmailAt`, since kind is fixed. |
| `overdueAt` | First overdue-handling timestamp (`invoiceOverdue`), set before pausing or voiding. A void upgrade with this marker resumes cancellation on retry. The daily overdue query uses `overdueEmailAt = null`, not a null `overdueAt` (`syncOrgInvoices`). |
| `createdAt`, `updatedAt` | DB/default and Prisma timestamps. |

SQL enforces positive totals, nonnegative credits, allowed kinds/statuses and an FK to `OrgBilling`, with cascade deletion. Indexes: `(orgId, issuedAt)` and `(status, dueDate)`. Currency, tax cents, paid-date/status agreement and subscription ownership are not SQL checks (migration above).

## How it works

### Details and tax

1. `saveBillingDetails` parses before any billing change. Invalid data returns `BillingError` 400 with the first field path/problem. Unknown fields are rejected by `.strict()`. Strings are trimmed; country/tax ID uppercased; emails lowercased and deduplicated. Legal name/street are 1–200 characters, line2 at most 200, city 1–100, postal code 1–20, tax ID at most 50, email at most 320, 1–5 email entries before deduplication. Countries use `Intl.DisplayNames` with reserved/noncountry exclusions (`web/lib/billing/details.ts` `billingDetailsInput`, `countryName`).
2. India requires a listed GST state code (retired 25/28 absent). An optional GSTIN must match the 15-character pattern, pass its mod-36 checksum and match the state's first two digits. A non-India state is refused (`billingDetailsInput`, `gstinChecksumOk`).
3. `locked` serializes details, upgrades and pack requests with a PostgreSQL org advisory transaction lock, timeout 60 seconds / max wait 30 seconds. The Meteroid customer PATCH runs **before** the local update. External failure rolls back the app update; there is no shared transaction with Meteroid (`billing.ts` `locked`, `saveBillingDetails`, `viaMeteroid`).
4. `meteroidCustomerPatch` sends name, address, tax ID, first billing email plus all invoicing emails, custom taxes and export exemption. India prints `State name (code)` on line2, appended to the entered line2, and also sends the state field. Tamil Nadu (33) gets CGST 9% + SGST 9%; other India IGST 18%; outside India no tax and LUT exemption wording, with `GST_LUT_REFERENCE` if supplied (`details.ts` `addressLine2`, `taxFor`, `exportMention`, `meteroidCustomerPatch`). Meteroid applies the customer's tax when issuing invoices; invoice copies keep Meteroid's amounts (`billing.ts` `recordInvoice`).

### Upgrade and cancellation

1. `requestUpgrade` requires billing (404 if absent), Trial (Paid returns 409), then details (400). An existing Paid subscription ID returns `{subscriptionId, created:false}` without a new request.
2. It finds the active Meteroid plan named `Paid`, uses its first price component, and creates a manual-collection subscription starting on today's UTC date, activation `ON_START`, net terms 2 days. Optional custom cents override the monthly rate in USD. The key is `paid-subscription-<org>-<UTC day>-<count of all upgrade copies>`. Allowed response states are ACTIVE / PENDING_ACTIVATION / PENDING_CHARGE; another state returns 409 (`meteroid.ts` `paidPlan`, `createPaidSubscription`; `billing.ts` `requestUpgrade`).
3. Save its ID; keep the app on Trial. Try `syncOrgInvoices` immediately so the first invoice appears without waiting for the webhook. Sync failure is logged, not returned as an upgrade failure. Meteroid owns monthly renewal anchored to the subscription's requested start date.
4. `invoicePaid` refreshes payment first. It activates Paid when the stored subscription matches, or when the stored ID is null and Meteroid says the invoice's subscription is ACTIVE / PENDING_ACTIVATION / PENDING_CHARGE. A different stored ID, or a cancelled subscription with no stored ID, leaves the plan unchanged, logs for staff and emails “We'll be in touch about your plan.” Matching IDs bypass the live-status check (B14 below). No plan credits are granted.
5. At overdue time, `invoiceOverdue` refreshes Meteroid first. Set `overdueAt` before voiding an unpaid upgrade by gRPC, then set the copy void and cancel its subscription effective today by REST. A failed void re-reads payment: PAID means no cancellation. Cancellation errors are tolerated only if the subscription is already CANCELLED / COMPLETED / ABORTED. Clear the matching Trial subscription ID and send upgrade-cancelled email. A void upgrade with `overdueAt` continues from cancellation on retry; failed cancellation/email is also retried by the daily check. Other void invoices stop.
6. Signed cancelled/ended events resolve by subscription ID **before** any customer/org lookup, clear the matching Paid subscription ID, set Trial and clear pause. The daily check also reads a stored subscription's status and applies this effect for CANCELLED / COMPLETED / ABORTED. There is no customer cancel button (`paidSubscriptionEnded`, `syncOrgInvoices`; webhook POST; `billing-section.tsx` `PlanCard`).

### Buy packs

`buyPacks` accepts whole packs 1–10. Details must exist (400); the plan must be Paid and not paused (409, with separate messages). `packPrice` calculates the net cents near `floor(gross × 10000 / (10000 + total tax bp))`: try ±5 net cents, round each tax half upward separately, choose the closest total not above $25 × packs, at most one cent short. Divide net dollars by credits and give Meteroid an 8-decimal unit price; assert that it rounds back to net cents (`web/lib/billing/pricing.ts` `packPrice`, `totalWithTax`).

POST the Meteroid top-up with `amount = packs × 100`, `MINS`, `collection: SEND_INVOICE`, the net unit price and expiry at 23:59:59 UTC on request day +365 days. Key: `pack-<org>-<requestId>`. Read/store the invoice afterward; read failure is logged and returns its ID with null number/total (`billing.ts` `buyPacks`, `packExpiry`; `meteroid.ts` `createPackInvoice`). The tRPC input requires a UUID. `PacksCard` keeps one UUID for the selected quantity: an error retry reuses it, a quantity change or successful response generates a new one. It is component state, not persisted across reloads (`billing-section.tsx` `PacksCard`).

The app does not grant pack credits or mark the invoice paid. Meteroid grants PAID credits after payment; `wallet.funded` schedules `syncOrgCredits`, which refreshes the balance/grants and announces new grants to the admin. The paid invoice email and that credit-added email are separate. See [Credits](credits.md#how-it-works) (`web/app/api/meteroid/webhook/route.ts` POST; `web/lib/schedule-org-credits.ts` `scheduleOrgSync`; `web/workflows/sync-org-credits.ts` `syncOrgCredits`).

### Copy invoices and claim workflows

`syncInvoice` GETs the invoice, resolves its customer to an org unless an org was supplied, then calls `recordInvoice` and `startInvoiceWorkflows`. A first-seen nonpositive, DRAFT or VOID invoice is ignored. `UNCOLLECTIBLE` maps to void; PAID maps to paid; partial/processing/errored payment maps to unpaid. A paid/void copy cannot regress to unpaid, but paid and void can replace each other. Existing copies update amounts/dates/references, not kind/org (`billing.ts` `recordInvoice`, `statusOf`).

For early upgrade webhooks, `kindOf` can recognize a Paid-plan subscription while Trial has no stored ID and set that ID, but only when Meteroid reports ACTIVE / PENDING_ACTIVATION / PENDING_CHARGE. Otherwise matching current subscription + Trial means upgrade, matching + Paid means renewal, nonmatching subscription means other. No-subscription packs use the exact Meteroid line name `Purchase credits` (`billing.ts` `kindOf`; `meteroid.ts` `toInvoice`).

Atomic claims precede workflow startup. Non-void invoices claim issued once; paid invoices claim paid once. The `invoice.paid` webhook passes a paid hint even when the API still returns unpaid, so the paid workflow starts then too. Startup failure logs and clears the claim; a started-but-dead workflow retains its claim for daily repair (`billing.ts` `claim`, `startInvoiceWorkflows`).

### Invoice timers, payment, pause and resume

- `invoiceIssued` refreshes, returns immediately if void, then sends the issued email. Pack/other stop there. Renewal sleeps to 00:00 UTC the day before due and calls `invoiceReminder`, then sleeps to overdue time. Upgrade only sleeps to overdue time. Past times cause no sleep. Reminder refreshes, requires renewal/unpaid and the exact UTC day before due. Overdue handling refreshes and requires overdue plus unpaid, or a void upgrade with an existing overdue marker (`web/workflows/invoice-issued.ts` `invoiceIssued`, `until`; `web/lib/billing/billing.ts` `invoiceReminder`, `invoiceOverdue`).
- Overdue renewal writes `overdueAt` and pauses only a matching current subscription on Paid. Re-read Meteroid **after** the pause; if paid meanwhile, call `invoicePaid` to undo the pause and process payment instead of sending paused mail. Otherwise send the pause email only if the org is still paused on that subscription. No invoice kind other than renewal pauses (`billing.ts` `pauseFor`, `invoiceOverdue`).
- `invoicePaid` workflow makes **12 checks**, each calling `handlePaid` (which refreshes Meteroid), with a 10-second sleep after each unpaid check. PAID stops the loop. If all checks remain unpaid it returns `not_paid`; later daily checks can repair it. This covers Meteroid sending invoice.paid before its GET API shows PAID (`web/workflows/invoice-paid.ts` `invoicePaid`; `web/workflows/steps/billing.ts` `handlePaid`).
- The library `invoicePaid` applies the effect **before** sending email: upgrade activates Paid under the subscription guard above; renewal counts only the org's **current subscription's** other unpaid overdue renewal copies and clears pause if none remain. Old renewals neither block current unpause nor allow unpause while a current renewal is overdue. Renewal email outcome comes from `pausedAt` after the update: active, or still paused until the other overdue invoice is paid. Pack reports credits being added by Meteroid; other has no plan effect. Repetition re-applies these effects and checks the email marker (`billing.ts` `invoicePaid`).
- New voice calls read only `pausedAt` and return `MinutesError` 403 before closing other learner calls or reading call balances. Studio: “Your organization's plan is paused because an invoice is overdue. Pay it to continue (Settings › Billing).” Learner: “Practice is paused for this organization right now. Please ask your trainer.” Live resume returns before this check; pause does not change existing allowances or remove credits. Staff chat is unaffected (`web/lib/billing/paused.ts` `pausedReason`; `web/lib/interview-sessions.ts` `activateSession`; [Sessions](sessions.md)).
- Learner grants call `refuseWhenPaused` before writing. Starting grants only check if somebody actually needs a first grant; no-op/fully skipped batches can succeed. People additions run starting grants before account/member creation, so ordinary new learners are refused while team/admin additions do not use this check (`web/lib/minutes.ts` `grantMinutes`, `giveStartingMinutes`, `grantMinutesToMany`, `refuseWhenPaused`; `web/lib/org-people.ts` `addPeopleToOrg`; [Credits](credits.md)).

### Emails and PDFs

`emailOnce` reads the invoice's event marker. Billing recipients are the current details' emails or the enabled admin; no recipient logs and returns false. Issued/reminder/paused/paid need Meteroid's PDF: try 10 reads, sleeping 3 seconds after each unavailable PDF, then throw for step retry. Paid also renders the local receipt. Send via Resend with `billing-<event>-<invoice id>`, then save the marker. Ordinary send failure throws. Missing `RESEND_API_KEY` is treated as completion even though sending was skipped (`billing.ts` `recipients`, `pdfOf`, `emailOnce`; `web/lib/email.ts` `sendBillingEmail`, `sendEmail`).

| Event | Attachment / saved field |
| --- | --- |
| issued (all non-void kinds) | `<number>.pdf` / `issuedEmailAt` |
| reminder (unpaid renewal, due-tomorrow day only) | `<number>.pdf` / `reminderAt` |
| paused (current renewal) | `<number>.pdf` / `overdueEmailAt` |
| upgrade_cancelled | None / `overdueEmailAt` |
| paid (all paid kinds) | `RCPT-<number>.pdf`, then `<number>.pdf` / `paidEmailAt` |

`billingEmail` builds escaped HTML and plain text, with Billing URL, amounts formatted in the invoice's currency by `pricing.ts` `formatMoney`, due date, payment instructions on issued/reminder/paused, and payment outcome on paid. Default sender is `TrainerTwin Billing <billing@trainertwin.com>`, configurable by `BILLING_FROM_EMAIL`, reply-to support@trainertwin.com. Without instructions, copy points to the attached invoice. Full subjects/recipient boundaries: [People and emails](invites-and-emails.md#billing-emails) (`web/lib/email.ts` `billingEmail`, `sendBillingEmail`).

`receiptPdf` uses **current** app billing details, not an invoice-time customer snapshot. `renderReceipt` makes one A4 page: Payment receipt, RCPT number, UTC paid date, seller name/address/GSTIN, customer name/address/tax ID (org name if no details), invoice/date/description, total/tax, full amount received, payment references, zero balance and SAC 998314. Amounts use the invoice's currency. Fixed Helvetica fonts use WinAnsi; unsupported currency symbols (such as ₹) use a currency code instead (`money`), other unsupported characters become `?` (`safe`), and text is not wrapped. Identical inputs yield identical bytes: metadata uses `paidAt`, not the clock, and automatic metadata updates are off. Changed customer details still change the bytes. Meteroid's invoice remains the tax invoice (`billing.ts` `receiptPdf`; `receipt.ts` `SELLER`, `money`, `safe`, `renderReceipt`).

`orgInvoice` scopes downloads to the signed-in org (404 otherwise). Invoice PDF is fetched live: 502 external failure, 409 not ready. Receipt requires stored paid status (409 otherwise) and works without Meteroid. Routes require authentication (401), enabled studio membership (403 otherwise), PDF content type, attachment filename, private/no-store (`billing.ts` `invoicePdfFor`, `receiptPdfFor`; both invoice GET routes). UI download buttons use `fetch`, read the blob, click a temporary object-URL download and revoke it. The tab's `OrgPin` fetch wrapper sends its org header, unlike a plain anchor; non-OK responses toast the route error (`billing-section.tsx` `download`; `web/components/org-pin.tsx` `install`).

### Daily repairs and local UI

`checkAllBilling` visits every `OrgBilling`, isolates per-org errors and returns results. `syncOrgInvoices` does this (`billing.ts` `syncOrgInvoices`, `checkAllBilling`; `meteroid.ts` `listInvoices`):

1. Read the newest **50** Meteroid invoices, record them and start missing workflows. A claim is considered dead after **10 minutes** without its email (wall-clock `Date.now`, not the supplied simulated `now`). Directly handle missing paid effect/email first; otherwise missing issued email. These repair failures log and continue; record/start errors can still abort this org's pass.
2. Select local overdue upgrade/renewal copies with `overdueEmailAt = null`: unpaid rows, plus void upgrades whose `overdueAt` is non-null. Call `invoiceOverdue` for each in its own try/catch. This finishes partial upgrade cancellation and repairs missing paused mail even after `overdueAt` was written. One overdue failure does not stop later rows.
3. If paused, count unpaid overdue renewals of the **current subscription**. Clear pause if none remain (including when the overdue invoice was voided).
4. GET the stored Paid subscription, including a pending Trial subscription. CANCELLED / COMPLETED / ABORTED calls `paidSubscriptionEnded`: Trial, no ID, unpaused. This status-read failure can abort the org's result after earlier repairs.

No direct reminder repair runs. A newly restarted issued workflow still calls `invoiceReminder`, which sends only on the correct day; missed reminders are best effort, never sent later.

Vercel GET cron `/api/internal/billing/check` runs **daily at 00:15 UTC** (`web/vercel.json`). Route GET/POST accepts Bearer or x-internal-secret matching `CRON_SECRET`, falling back to `INTERNAL_API_SECRET`. No configured secret allows only off-Vercel execution; on Vercel it fails closed. Route limit is 300 seconds; per-org errors still return `{ok:true, orgs}` (`web/app/api/internal/billing/check/route.ts` `isAuthorized`, GET).

`billingOverview` reads only the app, newest 100 invoice copies, and supplies plan/details/prices, pending upgrade and latest matching unpaid/overdue renewal views. On Paid, `renewsOn` is the largest `periodEnd` among non-void copies matching the current subscription, or null without a period. This is an invoice-derived date, not a live subscription lookup. Settings shows it beside the monthly price; details; packs only on Paid, with expiry copy “a year after the invoice date”; invoice statuses/download buttons and paid receipts. Paused pack purchase is disabled. URL `?tab=billing` selects the tab only for studio roles, otherwise Account. `BillingBanner` fetches its own overview key, stale time 5 minutes, retries off: pause alert first, otherwise **any current-subscription** unpaid renewal's due date (not only tomorrow). It has no polling interval (`web/lib/billing/billing.ts` `billingOverview`; `web/components/billing/billing-section.tsx` `BillingSection`, cards; `billing-banner.tsx` `BillingBanner`; `web/app/dash/settings/page.tsx` `SettingsPage`; `web/app/dash/layout.tsx` `DashLayout`).

### Lifecycles in words

- Plan: Trial → request → Trial with pending Paid subscription → upgrade payment → Paid → overdue current renewal → Paid paused → all current-subscription overdue renewals paid/void → Paid unpaused. Pending upgrade overdue → void + cancel → Trial without pending ID. Cancelled/ended current Paid subscription → Trial unpaused (`billing.ts` `requestUpgrade`, `invoiceOverdue`, `invoicePaid`, `paidSubscriptionEnded`).
- Invoice: unseen finalized positive invoice → unpaid copy → paid or void. Paid/void never → unpaid by a stale read. Pack/other can remain unpaid indefinitely without pause (`recordInvoice`, `invoiceOverdue`).
- Delivery: null claim → claimed timestamp → workflow started → email marker; startup failure → null claim; claimed >10 minutes without email → direct daily repair. Send failure leaves marker null; successful send (or missing Resend key) sets it (`claim`, `startInvoiceWorkflows`, `emailOnce`, `syncOrgInvoices`).

## Rules

1. All four billing tRPC procedures require admin/team; learners are FORBIDDEN. PDF access is same-org studio only (`web/lib/billing/trpc.ts` `billingRouter`; `web/lib/trpc.ts` `studioProcedure`; PDF GET routes).
2. Invalid details return the first problem with 400 before any remote write; valid saves patch Meteroid before app JSON (`billing.ts` `saveBillingDetails`; `details.ts` `billingDetailsInput`). Unknown detail fields are rejected by `.strict()`.
3. Upgrade requires Trial plus details and reuses a stored pending subscription ID. Paid returns 409 (`billing.ts` `requestUpgrade`).
4. Whole packs 1–10 require details, Paid and no pause. Pack total cannot exceed nominal price and is at most one cent short for supported taxes (`billing.ts` `buyPacks`; `pricing.ts` `packPrice`).
5. The app billing request/workflow path never calls `markInvoicePaid` or grants pack credits; that gRPC helper is for the live-check script/tests (`meteroid.ts` `markInvoicePaid`, `createPackInvoice`; `billing.ts` `invoicePaid`).
6. First-seen zero/draft/void invoices are ignored; DB rejects totals ≤0. Known kinds persist; stale reads cannot make paid/void unpaid (`billing.ts` `recordInvoice`; billing migration).
7. At most one issued and paid workflow claim wins concurrently per invoice. A failed start releases it (`billing.ts` `claim`, `startInvoiceWorkflows`).
8. Only unpaid renewals get reminders on the UTC day before due; only current Paid renewal copies can pause. Upgrade overdue voids/cancels, pack/other never pause (`invoiceReminder`, `invoiceOverdue`, `pauseFor`).
9. Call/grant refusal reads only local pause state; resumes bypass pause. No billing pause operation removes credit cache or ledger balances (`paused.ts` `pausedReason`; `interview-sessions.ts` `activateSession`; `minutes.ts` `refuseWhenPaused`; `billing.ts` `pauseFor`).
10. Paid renewal processing clears pause only when no other overdue unpaid renewal copy of the current subscription exists, and the email outcome reflects pause state after the update. Paid plan/effects happen before receipt email (`billing.ts` `invoicePaid`).
11. Billing event email uses its stored marker and Resend event key. Failed sends retain null markers, except missing Resend configuration. Paid emails attach receipt then invoice (`billing.ts` `emailOnce`; `web/lib/email.ts` `sendEmail`).
12. Signed Meteroid callbacks accept flat or `data` fields, with flat fields winning. Bad signature is 401; malformed JSON 400; unknown customers/types are acknowledged and ignored, except subscription ending resolves the stored subscription ID without requiring a customer. Invoice read errors propagate for Meteroid retry (`web/app/api/meteroid/webhook/route.ts` POST; `web/lib/meteroid.ts` `verifyWebhook`).

## Entry points

| Entry | File + function |
| --- | --- |
| Settings `/settings?tab=billing` | `web/app/dash/settings/page.tsx` `SettingsPage`; `web/components/billing/billing-section.tsx` `BillingSection` |
| Studio-wide banner | `web/app/dash/layout.tsx` `DashLayout`; `web/components/billing/billing-banner.tsx` `BillingBanner` |
| tRPC `/api/trpc`: `billing.overview`, `saveDetails`, `upgrade`, `buyPacks` | `web/lib/app-router.ts` `appRouter`; `web/lib/billing/trpc.ts` `billingRouter` |
| POST `/api/meteroid/webhook` | `web/app/api/meteroid/webhook/route.ts` POST; handles wallet.funded/debited/depleted/recovered, credit_grant.expired, invoice.finalized/paid/voided, subscription.cancelled/ended |
| GET `/api/billing/invoices/:id/pdf`, `/receipt` | `web/app/api/billing/invoices/[id]/{pdf,receipt}/route.ts` GET |
| GET / POST `/api/internal/billing/check`; daily `15 0 * * *` | `web/app/api/internal/billing/check/route.ts` GET / POST; `web/vercel.json` |
| Invoice-issued / invoice-paid workflows | `web/workflows/invoice-issued.ts` `invoiceIssued`, `invoice-paid.ts` `invoicePaid`; `steps/billing.ts` `readInvoice`, `emailInvoice`, `remind`, `handleOverdue`, `handlePaid` |
| Five billing event emails | `web/lib/email.ts` `billingEmail`, `sendBillingEmail`; `web/lib/billing/billing.ts` `emailOnce` |
| Tenant setup | `bun scripts/meteroid-billing-setup.ts --webhook-url https://…/api/meteroid/webhook [--dry-run]` (top-level script). Needs existing product family, MINS, customer/entity and matching webhook. Creates absent Paid plan/product/credit price, patches entity and extends events. Existing active Paid plan is reused, not validated/repriced. Customer-email disabling is separate. |
| Custom price | `bun scripts/billing-price.ts --org <slug> --monthly <USD>` or `--clear` (top-level script); minimum $1, at most two decimals; app-only update. |
| Reapply saved customer details/tax | `bun scripts/billing-sync-customers.ts [--dry-run]` (top-level script). Selects billed orgs with non-null details, logs slug/tax/export wording, PATCHes each customer using `meteroidCustomerPatch`, then disconnects. Dry-run reads/logs only. Does not validate the saved JSON again, lock an org, change app data or rewrite issued invoices; stops on the first error, with no per-org catch or production guard. |
| Read-only rule checks | `web/scripts/check-billing.ts` `BILLING_CHECKS`, `checkBilling`; `bun scripts/check-billing.ts`, exit 1 for any broken count. |
| Live rehearsal | `web/scripts/billing-live-check.ts` `newOrg`, `payInMeteroid`, top-level lifecycle; local test DB, supplied dev/sandbox Meteroid key, no Resend, direct steps, customer/subscription cleanup in finally. Production-key/URL guard is heuristic, not tenant verification. |

## Talks to

### Meteroid calls

REST paths are relative to `METEROID_API_URL`; Bearer key, JSON and optional idempotency-key use `web/lib/meteroid.ts` `meteroid` (default timeout 10 seconds). Billing gRPC uses the same key in x-api-key, framed protobuf, 15-second timeout and checks HTTP plus grpc-status from headers/trailers (`web/lib/billing/meteroid.ts` `meteroidGrpc`, `encodeProto`).

| Protocol / request | Purpose / owner |
| --- | --- |
| REST PATCH `/customers/:id` | Billing fields/tax (`meteroid.ts` `patchCustomer`; `details.ts` `meteroidCustomerPatch`) |
| REST GET `/plans?per_page=100`, `/plans/:id` | Active Paid plan and first price component (`meteroid.ts` `paidPlan`) |
| REST POST `/subscriptions` | Manual Paid subscription / idempotent upgrade (`createPaidSubscription`) |
| REST GET `/subscriptions/:id`, POST `/subscriptions/:id/cancel` | Early-kind recognition, lost-ID upgrade payment checks, daily ended-subscription repair, cancellation checks and overdue upgrade cancellation (`getSubscription`, `cancelSubscription`) |
| REST POST `/customers/:id/top-ups` | SEND_INVOICE pack; no direct payment/grant (`createPackInvoice`) |
| REST GET `/invoices/:id`, `/invoices?customer_id=…&order_by=invoice_date.desc&per_page=50` | Invoice refresh/recent daily list (`getInvoice`, `listInvoices`, `toInvoice`) |
| REST GET `/invoices/:id/download` | Invoice PDF, 20-second timeout; 404 or non-%PDF- body = not ready (`invoicePdf`) |
| gRPC-web POST `meteroid.api.invoices.v1.InvoicesService/VoidInvoice` | Invoice ID field 1; overdue upgrade void (`voidInvoice`) |
| gRPC-web POST `meteroid.api.invoices.v1.InvoicesService/MarkInvoiceAsPaid` | ID field 1, decimal amount field 2, reference field 4; scripts/tests only (`markInvoicePaid`) |
| Setup-only REST | `web/scripts/meteroid-billing-setup.ts`: GET `/product_families`, `/credit-units`, `/products?per_page=100`, `/credit-units/:id/prices`, `/customers?per_page=1`, `/webhooks/endpoints`; POST `/plans`, `/products`; PATCH `/credit-units/:id`, `/webhooks/endpoints/:id`; PUT `/credit-units/:id/prices/USD`. |
| Setup-only gRPC-web | `meteroid.api.invoicingentities.v1.InvoicingEntitiesService/UpdateInvoicingEntity`: seller address/GSTIN, 2-day terms, SAC footer and contact (`meteroid-billing-setup.ts`). This is additional to the two invoice gRPC helpers above. |

Signed Standard Webhooks use ±300 seconds, HMAC-SHA256 of `id.timestamp.body`, base64 secret after `whsec_`, equal-length constant-time comparison (`web/lib/meteroid.ts` `verifyWebhook`). Flat fields support Meteroid 2.2.1, `data` supports newer payloads (`web/app/api/meteroid/webhook/route.ts` POST).

Other boundaries: PostgreSQL holds app copies/locks; Workflow SDK checkpoints steps and timers; Resend accepts messages/PDF attachments; pdf-lib makes receipts; credit sync owns the funded wallet and admin grant email. People/access/grant/call boundaries are linked above, not new billing implementations.

### Configuration

| Environment | Effect / pointer |
| --- | --- |
| `METEROID_API_KEY` | Tenant key for REST/gRPC; missing key throws (`web/lib/meteroid.ts` `env`; billing `meteroid.ts` `meteroidGrpc`, `invoicePdf`). |
| `METEROID_API_URL` | REST default `https://meteroid-rest.foreverlearning.in/api/v1` (`web/lib/meteroid.ts` `apiUrl`; billing `invoicePdf`). |
| `METEROID_GRPC_URL` | gRPC default `https://meteroid-api.foreverlearning.in` (`billing/meteroid.ts` `grpcUrl`). |
| `METEROID_WEBHOOK_SECRET` | Standard Webhooks secret (`web/lib/meteroid.ts` `verifyWebhook`). |
| `BILLING_FROM_EMAIL` | Default TrainerTwin Billing <billing@trainertwin.com>; read at module load (`web/lib/email.ts` `BILLING_FROM_EMAIL`). |
| `BILLING_PAYMENT_INSTRUCTIONS` | Trimmed instructions in issued/reminder/paused mail; default points to invoice (`billing.ts` `emailOnce`; `email.ts` `billingEmail`). Not added to Meteroid's PDF by this code. |
| `GST_LUT_REFERENCE` | Optional trimmed LUT reference in export customer's exemption reason (`details.ts` `exportMention`). Changing env alone does not patch saved Meteroid customers: save details again or run `billing-sync-customers.ts` with the app's tenant/env for future invoices. |
| `CRON_SECRET` | Cron auth; fallback `INTERNAL_API_SECRET`; `VERCEL` controls missing-secret fail-closed (`internal/billing/check/route.ts` `isAuthorized`). |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Shared mail transport / default nonbilling sender; missing key skips actual mail (`web/lib/email.ts` module initialization, `sendEmail`). |
| `DATABASE_URL` | DB connection, also used by customer sync; live-check substitutes the derived local test DB in both `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (`web/lib/db.ts`; `billing-live-check.ts` top level). |

No online payment provider is configured by these billing functions. Phase 1 Razorpay remains off unless `RAZORPAY_ENABLED=true`; see [Payments](payments.md).

## Edge cases and limits

- External success and local DB failure are not atomic. Meteroid may keep updated details/a subscription/top-up despite rollback or lost response; error copy saying “Nothing was changed” refers imperfectly to that boundary (`billing.ts` `locked`, `viaMeteroid`, request functions).
- Upgrade keys contain today's date; retries across UTC midnight can use a new key after a remote success/local failure. Pack retries recompute expiry and tax from today's/current details; the same request key can get a different body later. The UI keeps its requestId after an error, but resets it on quantity change, success or remount; it is not a persisted retry ID (`billing.ts` `requestUpgrade`, `buyPacks`, `packExpiry`; `billing-section.tsx` `PacksCard.buy`).
- Kind depends on app plan when first seen. A much-delayed first-paid event with several subscription invoices can classify more than one as upgrade; old-subscription invoices first seen after cancellation become other (`billing.ts` `kindOf`, `recordInvoice`).
- Recent-invoice fetch is one page (50), UI one page (100); there is no pagination or local PDF storage. Reminder/overdue/payment steps refresh Meteroid, while call refusal and overview never do (`meteroid.ts` `listInvoices`; `billing.ts` `billingOverview`, `refreshed`, `invoicePdfFor`).
- Banner state has no five-second credit-version invalidation or regular polling; mutations in Billing invalidate its query prefix, but an external payment/pause may need a refetch/reload. Query errors hide the banner (`billing-banner.tsx` `BillingBanner`; `billing-section.tsx` mutations).
- Receipt details can change after payment; unsupported scripts are replaced, long fields/references can extend beyond a column/page. Receipt formats the invoice currency, but does not add a second INR-conversion amount (`billing.ts` `receiptPdf`; `receipt.ts` `safe`, `renderReceipt`).
- Setup dry-run performs reads, suppresses writes. It updates only the entity found on the first customer and does not disable Meteroid customer emails or set bank details/FX conversion. Its PUT price call is outside the shared wrapper's declared method union (`meteroid-billing-setup.ts:71`; `web/lib/meteroid.ts:28`). This is a type-contract issue, not a new REST feature.

## Mismatches

These are differences from [Billing](billing.md) or the code's own comments/UI copy, not changes to the agreed rules. They remain code/release issues.

| ID / rule | Difference and source |
| --- | --- |
| B2 — 2 | USD pricing is configured, but not enforced when reusing a Paid plan or creating a customer top-up. `paidPlan` does not validate its currency; top-up sends no currency; `toInvoice` and the DB accept any invoice currency. Receipt/UI/email now correctly display that currency, so the old dollar-mislabel bug is fixed, but “all phase 2 invoices are USD” still depends on tenant/customer setup (`web/lib/billing/meteroid.ts:109,151–161,205–212`; `web/lib/billing/billing.ts:202,421,452`; billing migration lines 27,46–51). INR conversion on Meteroid PDFs remains unverified, not an asserted code failure (Open questions). |
| B10 — 21, Checks | Missing Resend key still sets the invoice email marker, suppressing later real delivery (`web/lib/billing/billing.ts:460–461`; `web/lib/email.ts:36–40`). Provider success followed by a crash/failed marker write also permits a duplicate after Resend's 24-hour key window (`web/lib/billing/billing.ts:433–461`; `web/lib/email.ts:17`). Deterministic receipt bytes for identical inputs do not make provider send and DB marker one transaction. |
| B11 — 25, Checks | Direct dead issued/paid workflow repair runs only for rows in Meteroid's newest-50 page, not all local dead claims. Within that page, `if … else if` repairs at most one of paid/issued completion per pass; a paid row with both claims dead and both markers null needs another pass for issued mail. Rule 25 now allows best-effort reminders and reads recent invoices; neither is itself a mismatch, but dead mail can still miss the daily repair promised by Checks (`web/lib/billing/billing.ts:484–498`; `web/lib/billing/meteroid.ts:126–129`). |
| B13 — Checks | The pending-upgrade grace is based on **any invoice copy created in the last hour**, not when the upgrade was requested. A fresh request without any copy can fail the check immediately; a recent unrelated invoice can hide an old pending subscription with no unpaid upgrade. The before-yesterday/current-renewal threshold and void-issued-email exemption now match Checks and are no longer mismatches (`web/scripts/check-billing.ts:19–23`). |
| B14 — 18; `invoicePaid` comment | The cancelled-subscription payment guard checks Meteroid status only when the app has lost the subscription ID. If the stored ID still matches a cancelled subscription (ending webhook/check not applied yet), payment can activate Paid and claim “now on the Paid plan” until the ending event/daily check repairs it. This contradicts the comment “never one that was cancelled”; the lost-ID case is fixed, not the matching-ID case (`web/lib/billing/billing.ts:340–350`; ending repair `378–379,522–523`). |

UI/copy difference:


Old rows B1, B3–B9 and B12 are removed: the fixes or reworded rules now cover them. The usual sender for pack-credit announcements is explicitly allowed by rule 19; missing-admin/key grant announcements remain a [People and emails](invites-and-emails.md#mismatches) issue, not a billing-sender mismatch. Pack-expiry copy, running-call reminder copy, paused attachment, workflow unit polling and live-check reminder dates are corrected at their owners above.

Older sections of `plans/billing-phase-2.md` still describe a Meteroid paid-PDF receipt, a new Trial plan, INR/USD selection and payment-day pack expiry. Its “What the build changed” section and the agreed billing rules supersede those sketches: code keeps Credits, makes app receipts, configures USD pricing and request/invoice-day expiry. Next-renewal display is now implemented (`receipt.ts` `renderReceipt`; `billing.ts` `billingOverview`, `packExpiry`; `web/lib/org-billing-setup.ts` `linkOrgToMeteroid`). PRODUCT.md has no conflicting billing-specific rule.

## Open questions

1. Has the LUT been filed, and what reference must be deployed? `exportMention` omits the number when absent; the plan still leaves accountant confirmation open (`web/lib/billing/details.ts` `exportMention`; `web/scripts/billing-sync-customers.ts` top level; `plans/billing-phase-2.md` Open questions).
2. Does every real tenant/entity print INR conversion on USD invoice PDFs, SAC/export wording and bank payment instructions, and have every customer-email kind disabled? The setup script adds SAC/contact but neither FX/bank settings nor disabled kinds, and only patches the first customer's entity (`web/scripts/meteroid-billing-setup.ts:10–11,74–93`; `web/lib/billing/billing.ts` `emailOnce`; [Billing](billing.md) rules 2, 9, 21). These outside settings were not inspected here.
3. Should staff custom prices apply immediately to existing Paid subscriptions? The script only changes the app's price/next upgrade; overview can show the new amount while renewal invoices retain Meteroid's old rate (`web/scripts/billing-price.ts:2–4,27–28`; `web/lib/billing/billing.ts` `monthlyCentsOf`, `billingOverview`).
4. How should request identity survive a reload, lost response across midnight or detail/tax edit? Upgrade key/pack expiry are recomputed; pack UI now reuses its UUID after an error, but only until quantity change, success or remount (`web/lib/billing/billing.ts` `requestUpgrade`, `packExpiry`, `buyPacks`; `web/components/billing/billing-section.tsx` `PacksCard`).
5. Must receipts preserve invoice-time customer details and non-Latin names without substitution? Current receipt uses mutable billing details and fixed WinAnsi fonts; maximum validated text has no wrapping (`web/lib/billing/billing.ts` `receiptPdf`; `web/lib/billing/receipt.ts` `safe`, `renderReceipt`).
6. Must a studio already open receive a pause/unpause banner without navigation? Credits poll their own version, but BillingBanner has only staleTime and no interval or billing-event push (`web/components/billing/billing-banner.tsx` `BillingBanner`; `web/components/credits/sidebar-credits.tsx` `useLiveCredits`).

## Tests today

| Layer | Coverage / limits |
| --- | --- |
| Unit | `web/tests/lib/billing-details-pricing.test.ts`: details/normalization/GST checksum, country/state validation, tax/LUT patch, all 1–10 packs for three tax cases, rounding, invoice-currency formatting, receipt text/metadata/unsupported characters, deterministic receipt bytes and EUR amounts, five escaped templates. `billing-meteroid.test.ts`: REST shape/pack recognition/references, protobuf framing/status errors, PDF readiness/failure, subscription/custom price/terms/key and top-up body. |
| Workflow unit | `web/tests/lib/billing-workflows.test.ts`: issued/reminder/overdue order and UTC timer dates; pack/other/void skips; immediate paid delegation; delayed PAID success and 12-check exhaustion; actual overdue actions and cancellation/paid-email failure propagation. Sleeps are mocked, not durable-runtime validation. |
| DB | `web/tests/lib/billing-phase-two.db.test.ts`: studio permissions and tRPC status mapping, PDF ownership/readiness/offline receipt, cron auth/fallback, SQL constraints/cascade, paused new learner versus team, and six check-script snapshots. Conditional on local test DB. |
| Flow | `web/tests/flows/billing-phase-two.flow.test.ts`: Trial/upgrade/cancel/paid lifecycle; partial cancellation/email failure recovered by step/daily retry; renewal paid during pause; live-only subscription adoption after a lost ID; new same-day attempt after staff cancellation; repeated webhook/claim/start failure; cancellation-payment race; reminders/pause/unpause/multiple/current-versus-old renewals; paused calls/grants/resume; packs/no app grant; five mail events/attachments/keys/late pause retries and invoice currency; flat/nested webhooks; missing copies; dead issued/paid repair; daily void-unpause/ended-subscription recovery and per-overdue error isolation. MSW Meteroid/Resend plus real local DB; workflow start mock runs immediate steps, not durable timers. |
| Live script | `web/scripts/billing-live-check.ts`: throwaway tenant customers, taxes, real PDFs/subscriptions/void/paid/pack grant and pause/unpause via direct steps. Renewal is a stand-in subscription, not a waited monthly cycle. Reminder checks now simulate the UTC day before due and assert no invoice-day reminder; emails are skipped. Not run for this spec edit. |

For this refresh, ran `cd web && bun test tests/lib/billing-details-pricing.test.ts tests/lib/billing-meteroid.test.ts tests/lib/billing-workflows.test.ts`: **106 pass, 0 fail**, 487 assertions. No DB/flow/browser/live services or customer-sync script were run. Important unverified boundaries: real early-paid propagation/durable 12×10s polling, monthly renewal/deployed cron, matching-ID cancelled-subscription payment, >50 invoices, cross-day/remount request retry, provider-accepted/DB-failed email retry past 24 hours, deployed tenant USD/INR/PDF/email configuration and long receipt layout. New recovery paths have flow assertions, not a live rehearsal in this spec refresh.
