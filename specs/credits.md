# Credits

> One credit is one minute of practice. Meteroid owns the org's credits; TrainerTwin owns learners' minutes. Giving minutes to learners spends org credits immediately. Admin/team voice calls spend org credits directly when the org is billed. Learner calls spend only the minutes already given to that learner. (`web/lib/org-credits.ts`; `web/lib/minutes.ts`; `web/lib/interview-sessions.ts`.)

## Who uses it

| Who | What they can do | Code |
| --- | --- | --- |
| TrainerTwin staff | Configure Meteroid, link an org and grant promotional credits; create its own paid plan/subscription and record outside-Razorpay payments in Meteroid. Retained phase 1 [Payments](payments.md) is always on. | `web/scripts/meteroid-setup.ts`, `meteroid-link-org.ts`; [Billing code](billing-code.md) |
| Admin / team | See org credits, grant learners minutes and buy minute packs on Paid when not paused. Their billed voice calls use org credits, not personal grants. | `web/lib/minutes-trpc.ts`; `web/lib/interview-sessions.ts`; `web/lib/billing/billing.ts` `buyPacks` |
| Learner | Uses their shared org/email balance for twin and role-play voice calls. | `web/lib/minutes.ts` `learnerBalance`; `web/lib/interview-sessions.ts` |

## Words used here

- **Billed org:** has an `OrgBilling` row. No row means zero org credits and free staff calls (`web/lib/org-credits.ts` `orgCredits`; `web/lib/interview-sessions.ts` `activateSession`).
- **Grant:** in Meteroid, credits added to an org with optional expiry; in `MinuteLedger`, minutes given to a learner. These are distinct records (`web/lib/meteroid.ts` `CreditGrant`; `web/lib/minutes.ts` `grantMinutes`).
- **Pending spending:** app spending not yet included in Meteroid's `as_of` balance (`web/lib/org-credits.ts` `uncountedSeconds`).

## Data

`OrgBilling` holds `orgId`, unique `meteroidCustomerId`, cached `balanceMinutes`, `balanceAsOf`, `grants` JSON, `syncedAt` and `announcedGrantIds` (grant IDs whose admin email is consumed). Org deletion cascades. `InterviewSession.chargesOrg` identifies staff sessions whose allowance spends org credits (`web/prisma/schema.prisma`; `web/prisma/migrations/20261110120000_org_credits_meteroid/migration.sql`).

Plan, paid subscription ID, billing details, pause and invoice fields also live on/under `OrgBilling`; no app paid-price field remains. `billingOverview.planCents` is derived from the last matching non-void upgrade/renewal invoice, while each org's actual plan/price lives in Meteroid (`web/lib/billing/billing.ts` `billingOverview`); see [Billing code — Data](billing-code.md#data) (`web/prisma/schema.prisma` `OrgBilling`, `BillingInvoice`). The balance and learner ledger are not replaced by the billing plan.

`MinuteLedger` remains append-only, in seconds, scoped to org and normalized email. New app writes are positive learner `grant`, nonpositive learner `usage`, or nonpositive staff `org_usage`. Usage requires a unique session ID. `meteroidSentAt` records reporting to Meteroid. Old `topup`, `refund`, `reclaim` rows remain historical; no current helper creates them. The migration marks pre-existing learner grants sent at their creation time, so they are not re-reported (`web/lib/minutes.ts`; migration above).

Learner balance is signed learner ledger movements (including historical reclaims) minus elapsed unrecorded learner calls, each capped at its allowance. Staff `org_usage` rows and `chargesOrg` sessions do not debit a learner (`web/lib/minutes.ts` `learnerMinutes`).

## How it works

### Provisioning and free trial

Founder onboarding now links new orgs automatically when Meteroid is configured. `linkOrgToMeteroid` gets or creates the customer by alias = slug, finds a non-archived `voice_minutes` metric and an ACTIVE/TRIALING/PENDING_ACTIVATION subscription whose plan counts it, or creates a subscription on the `Credits` plan with key `credits-subscription-${org.id}`. Missing metric/plan or subscription ID throws before OrgBilling upsert. Linking twice reuses the customer/subscription and upserts the org's customer ID. The operator link script uses the same helper. (`web/lib/org-billing-setup.ts`, `web/scripts/meteroid-link-org.ts`.)

`grantTrialMinutes({id,createdAt}, customerId)` gives 30 PROMOTIONAL MINS, reason `Free trial`, expiring exactly `createdAt + 30 days`, key `trial-${org.id}-${customerId}` (`web/lib/org-billing-setup.ts` `grantTrialMinutes`). Onboarding runs it after Chroma and billing setup, in the workflow or direct fallback; no Meteroid key skips billing and the trial. New billed orgs therefore get 30 free trial credits, not a permanent zero-credit starting policy. OrgBilling starts with a zero cache; the grant becomes visible after refresh and Meteroid catch-up. Once spent/expired or below the 5-credit minimum, admin/team voice calls are refused until the org has enough credits again (staff grants, or paid minute packs on Paid). (`web/lib/minutes-config.ts` TRIAL_MINUTES/TRIAL_DAYS; `web/workflows/onboard-org.ts`.)

Meteroid requires identical bodies when reusing an idempotency key (different body returns 409). Trial expiry is anchored to org creation, not retry time. The retained, always-on phase 1 purchase path uses recorded `paidAt + 365 days` with key `razorpay:${paymentId}`; phase 2 packs instead send expiry at the end of request day +365 days. See [Payments](payments.md) and [Billing code](billing-code.md) (`web/lib/credit-purchases.ts` `purchasePaid`; `web/lib/billing/billing.ts` `packExpiry`, `buyPacks`).

Failed onboarding unlinks a saved billing customer: cancel all subscriptions except CANCELLED/ENDED, PATCH its alias to `${customerId}-onboarding-failed` so the slug can be reused, then DELETE/archive. Archive 400 is retried up to ten attempts with one-second sleeps; non-400 errors propagate immediately. Cleanup is best-effort at the route. (`web/lib/org-billing-setup.ts` `unlinkOrgFromMeteroid`.)

### Buy credits now

Admin/team on Paid, with billing details and no pause, buy 1–10 packs of 100 credits for $25 each, tax included. `buyPacks` asks Meteroid for a top-up with `collection: SEND_INVOICE`, net unit price and expiry; an unpaid invoice adds no credits. A validated Razorpay payment marks it paid automatically; staff mark payments made outside Razorpay in Meteroid. Meteroid creates the PAID grant, then `wallet.funded` schedules `syncOrgCredits`: refresh the org cache and announce the new grant to the admin. The billing paid workflow sends the receipt, not the credit grant. Trial cannot buy packs; an unpaid pack never pauses the org. There is no self-serve upgrade: staff create the org's own CUSTOM subscription in Meteroid; `kindOf` adopts any live non-`Credits` subscription, and its upgrade payment activates Paid. The Billing page tells Trial orgs to contact TrainerTwin; plan options/switching is future work, issue #19 ([Billing](billing.md) rules 2, 10; `web/lib/billing/billing.ts` `kindOf`; `web/components/billing/billing-section.tsx` `PlanCard`). Prices/tax/invoices belong to [Billing rules](billing.md) and [Billing code](billing-code.md), not the learner ledger (`web/lib/billing/billing.ts` `buyPacks`, `invoicePaid`; `web/lib/billing/meteroid.ts` `createPackInvoice`; `web/app/api/meteroid/webhook/route.ts` POST; `web/workflows/sync-org-credits.ts` `syncOrgCredits`).

### Org balance

`orgCredits(orgId, { fresh?, tx? })` returns `{ billed, seconds, minutes }`:

1. Without billing, return zero. Otherwise use the cached Meteroid balance by default.
2. With `fresh`, ask Meteroid's wallet endpoint with a 2.5-second timeout and store the result; any failure falls back to the cached copy.
3. From cached grants, subtract the **full** minutes of grants whose `expiresAt <= now` and `expiresAt > balanceAsOf`, and schedule an org sync if any exist. Grants expired at/before `as_of`, future expiries and grants without expiry need no adjustment. This is conservative: some of the expired minutes may already have been spent.
4. Subtract learner grants and staff `org_usage` not sent, or sent **at or after** `balanceAsOf`. Count positive grant seconds and the absolute staff usage seconds.
5. Subtract elapsed staff calls with `chargesOrg`, an allowance and a start time, excluding failed/revoked sessions and sessions with a ledger row. Cap each at `allowedSeconds`.
6. Floor seconds/60 for minutes. The Credits page clamps displayed org minutes at zero (`web/lib/org-credits.ts`; `web/lib/minutes-trpc.ts` `minutes.org`).

### Give learners minutes

`grantMinutes`, `giveStartingMinutes` and `grantMinutesToMany` take an org advisory transaction lock. They check fresh org credits minus pending spending before writing grants. Too little returns `MinutesError` 409. The lock prevents parallel grants spending the same org credits (`web/lib/minutes.ts`).

`refuseWhenPaused` reads local `OrgBilling.pausedAt` and throws `MinutesError` 403 with the studio billing message before a grant is written. Single grants check after the onlyIfNew no-op; starting/bulk grants check only when at least one grant is needed. Normal new learners are therefore refused before account/member creation, while existing/no-grant-needed batches and admin/team additions can continue. Someone with historical starting credits in this org gets no new grant and can be added while paused, as allowed by [Billing](billing.md) rule 16; see [Billing code](billing-code.md). Pause never removes credits (`web/lib/minutes.ts` `refuseWhenPaused`, `grantMinutes`, `giveStartingMinutes`, `grantMinutesToMany`; `web/lib/org-people.ts` `addPeopleToOrg`; [Billing](billing.md) rule 16).

Starting grants normalize/deduplicate emails, apply only when no prior grant exists for org/email and are all-or-nothing for a batch. Re-adding/reassigning does not replenish spent minutes. `addPeopleToOrg` is the only runtime starting-grant caller: it checks role/disabled state, commits grants, then creates missing accounts/members (`web/lib/org-people.ts`). An active common twin `/s/` link calls this service when its page opens, before prejoin and the page's balance check; activation uses join=false and never grants or adds people (`web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/twin-access.ts` `twinAccessByCode`; `web/lib/interview-sessions.ts` `activateSession`). Default is 30; chosen amounts are positive whole minutes, at most 360. Ordinary grants cannot exceed 360 minutes given in total (historical reclaims reduce that total; usage does not). Bulk additions skip people who cannot fit the chosen amount, then require enough org credits for everyone remaining. Successful writes schedule usage reporting (`web/lib/minutes.ts`; `web/lib/minutes-config.ts`).

### Calls

New learner voice calls require at least `MIN_START_MINUTES = 5` (300 seconds); learner chat is refused. At zero/negative balance the refusal is `OUT_OF_MINUTES`; a positive short balance says “You need at least 5 minutes to start a call; you have N. Ask your trainer for more.” Billed staff voice similarly requires 300 org seconds, sets `chargesOrg=true` and uses all available org seconds as allowance; nonpositive uses `ORG_OUT_OF_CREDITS`, otherwise “Your organization needs at least 5 credits to start a call; it has N. Contact TrainerTwin to add more.” These are `MinutesError` 403, exposed as `code: "minutes"`. New staff and learner voice calls are also refused with 403 while `OrgBilling.pausedAt` is set: staff are directed to Settings › Billing; learners to their trainer. The pause check uses the app copy, before ending other learner calls or reading balances. Resumed live calls bypass both pause and minimum checks and keep their allowance; staff chat and unbilled staff voice remain unmetered (`web/lib/interview-sessions.ts` `activateSession`; `web/lib/billing/paused.ts` `pausedReason`; `web/lib/minutes-config.ts`; [Sessions](sessions.md), [Billing](billing.md), [Billing code](billing-code.md)).

Shared-session learner pages refuse below 5 whole minutes and return `{kind:"outOfMinutes",email,minutesLeft}` (clamped nonnegative). Positive short balances show “Not enough practice minutes” and explain that a call needs at least 5; zero shows “Out of practice minutes”. Twin profile and “Start another” buttons disable below 5 (`web/lib/pages/learner.ts`, `web/app/(org)/s/[code]/page.tsx`, `web/components/twin/twin-learner-flow.tsx`).

Finalization floors elapsed seconds, clamps to zero/allowance and records one row per session. `chargesOrg` selects `org_usage`; otherwise metered sessions write `usage`. Repeated/parallel finalization cannot double-charge; positive staff usage schedules reporting (`web/lib/minutes.ts` `sessionUsageSeconds`, `recordSessionUsage`).

### Send and refresh

`sendOrgUsage` sends up to 500 unsent grant/staff rows, one `voice_minutes` event per row, using the row ID as event ID. Properties include decimal minutes (absolute seconds/60), kind (`given_to_learner` or `staff_call`), email and optional session. Only after successful ingestion are rows marked sent. Repeating does not resend marked rows; Meteroid deduplicates event IDs if sending succeeded before marking failed (`web/lib/org-credits.ts`; `web/lib/meteroid.ts` `sendUsage`).

`reportOrgUsage` sends once, then polls refresh up to 20 times with 3-second sleeps until Meteroid's `as_of` is strictly later than sentAt. `syncOrgCredits` refreshes then announces unseen positive grants to the enabled org admin through its announce step (`web/workflows/sync-org-credits.ts`; `web/workflows/steps/org-credits.ts`; `web/lib/org-credits-email.ts`).

`refreshOrgCredits` reads MINS grants and balance. For grants expired after that balance's `as_of`, it sends one zero-minute `voice_minutes` event per grant: ID `expired-<grantId>`, `properties.minutes = "0"`, kind `recount_after_expiry`, and `grant = <grantId>`. Meteroid deduplicates these IDs. Meteroid also sends `wallet.funded` before `wallets/check` includes the new grant (about two seconds later, verified live). Refresh re-reads balance while any grant is lapsed relative to `as_of` **or** has `createdAt > as_of`: up to five re-reads, waiting two seconds before each (at most ten seconds of sleeps). It stops when both conditions clear; grants created at/before `as_of` or without a creation time alone cause no wait. It stores the last balance/as_of, grants (including expired history) and sync time even if still behind; `orgCredits` still applies the conservative expiry subtraction then. A newly funded grant may remain invisible in the balance until a later sync if all five re-reads stay behind. After recount, subsequent refreshes send no expiry events. `counted` still only compares `as_of > sentAt` (or is true without `sentAt`); it is not an expiry-recount success flag.

Schedulers log errors and never throw; unsent rows remain recoverable on later spending or a stale Credits page (`web/workflows/report-org-usage.ts`, `web/workflows/sync-org-credits.ts`, `web/workflows/steps/org-credits.ts`; `web/lib/schedule-org-credits.ts`).

People-add/assignment workflows call addPeopleToOrg first and queue one combined person email after writes. The give-credits workflow resolves enabled learners, skips staff/disabled/nonmembers/cap overflow, grants others and queues their amount/new-balance email. Queued emailFailures=0 is not delivery proof; REST sends inline first for emailSent and queues failures with the same event key. Startup fallback sends inline with the original event keys. Both are allowed by People rule 12. No email failure refunds credits. See [People and emails](invites-and-emails.md) (`web/lib/invite/{org,twin,roleplay,credits}.ts`; `web/lib/queue-emails.ts`; `web/workflows/give-credits.ts`).

### Live studio refresh

The studio sidebar polls studio-only `minutes.version` every five seconds. This opaque string fingerprint reads only `OrgBilling.balanceMinutes`, grant IDs/statuses and the newest org `MinuteLedger` row ID: no Meteroid call. Repeated reads without those changes are stable; giving learner credits, recording staff `org_usage`, or changing the cached balance/grant status changes it (`web/lib/minutes-trpc.ts`).

The first value establishes a baseline without invalidation. Each changed value invalidates `minutes.org`, `page.credits`, `minutes.learner` and `page.users`, so mounted credit displays (including the sidebar and Remaining credits card) update without a reload, normally within one five-second polling interval after the database sync. Polling does not itself sync Meteroid, and background-tab timer throttling/network delays can extend that time (`web/components/credits/sidebar-credits.tsx` `useLiveCredits`).

## Rules

1. The org's balance is not a sum of `MinuteLedger` org top-ups or learners' unused minutes (`web/lib/org-credits.ts`).
2. Only admin/team may manage credits. Staff cannot receive learner grants; their calls spend the org's credits directly (`web/lib/minutes-trpc.ts` procedures; `web/lib/invite/credits.ts` `giveLearnerCredits`; starting additions `web/lib/org-people.ts`).
3. There is no take-back/set-balance procedure or current reclaim helper (`web/lib/minutes-trpc.ts`; `web/lib/minutes.ts`).
4. `creditsAdded(orgId, email)` requires an email and returns learner grants only, newest first, default limit 200, with actor name/email/null (`web/lib/minutes.ts`).
5. `minutes.org` returns `{ billed, balanceMinutes, addedMinutes, defaultMinutes, maxMinutes, grants, learners }`, not `topups`. Added minutes sum cached Meteroid grants, including expired ones. History notes combine reason with `expires d Mon yyyy` or `expired d Mon yyyy`; staff are excluded from learners. Copies older than 60 seconds refresh and schedule any unsent usage (`web/lib/minutes-trpc.ts`).
6. Paused orgs cannot write new learner grants or start new staff/learner voice calls (403). No-op grants and live-call resumes are not pause refusals. No credits are removed by pausing (`web/lib/minutes.ts` `refuseWhenPaused`; `web/lib/interview-sessions.ts` `activateSession`; [Billing code](billing-code.md)).

## Entry points

- `/credits`, learner dialogs and users/assignment grant forms: `web/components/credits/*`; `web/lib/minutes-trpc.ts` (`org`, `version`, `learner`, `add`, `addMany`, `addPeople`).
- People additions and assignment/common-link joins use starting grants through addPeopleToOrg: `web/lib/invite/*`; `web/lib/twin-access.ts`; `web/app/api/v1/users/route.ts`, `assignments/route.ts`.
- `bun scripts/meteroid-setup.ts` configures MINS, the SUM `voice_minutes` metric and Credits plan. `bun scripts/meteroid-link-org.ts --org <slug>` links the customer/subscription; optional `--minutes`, `--expires`, `--reason`, `--grant-key` grant promotional credits. Remote writes require `--production` and non-sandbox keys; local requires `pv_dev_…` (`web/scripts/meteroid-setup.ts`, `meteroid-link-org.ts`).
- Packs: Settings › Billing / tRPC `billing.buyPacks`; invoice/payment processing belongs to [Billing code](billing-code.md) (`web/lib/billing/trpc.ts` `billingRouter`).
- POST `/api/meteroid/webhook`: Standard Webhooks signature, ±300 seconds, HMAC-SHA256 over `id.timestamp.body`, base64 key after `whsec_`. Valid wallet funded/debited/depleted/recovered and credit_grant.expired events schedule sync; customer may be top-level or under data (flat fields win). Invoice finalized/paid/voided and subscription cancelled/ended are billing events, not credit ledger writes; see [Billing code](billing-code.md). Unknown types/customers return ignored 200, except a cancelled/ended subscription is matched by its stored Paid subscription ID before customer lookup; bad signatures return 401 (`web/app/api/meteroid/webhook/route.ts` POST; `web/lib/meteroid.ts` `verifyWebhook`).

## Talks to

Meteroid REST uses `METEROID_API_URL` (default `https://meteroid-rest.foreverlearning.in/api/v1`) and Bearer `METEROID_API_KEY`. Wallet check uses `credit_unit=MINS`; grants list uses `per_page=100`; ingestion is POST `/events/ingest`. `METEROID_WEBHOOK_SECRET` verifies callbacks. Phase 2 Meteroid top-ups create PAID grants only after their invoice is paid; funded-wallet sync imports them. The retained phase 1 Razorpay path also creates PAID grants and is always on: `RAZORPAY_ENABLED` / `razorpayEnabled` are removed. Phase 3 links mark pack invoices paid, not direct credit grants. See [Payments](payments.md) and [Billing code](billing-code.md) (`web/lib/meteroid.ts`; `web/lib/billing/meteroid.ts` `createPackInvoice`; `web/lib/razorpay.ts` `call`; `web/lib/billing/razorpay.ts` `razorpayInvoicePaid`).

## Edge cases and limits

Observed live on the Meteroid 2.2.1 dev tenant: `wallets/check` retains expired grant credits until the next usage recount, and Meteroid sends **no** `credit_grant.expired` webhook. A zero-minute event triggers a recount in about three seconds; merely refreshing the wallet does not. The webhook route accepts expiry events if supplied but cannot rely on them. The local subtraction and recount above compensate for this quirk (`web/lib/org-credits.ts` `lapsedSince`, `refreshOrgCredits`).

Meteroid grants list is one page, usage sending one batch. Cached fallback is available only for linked orgs and still subtracts lapsed grants and pending app spending. Starting grants commit before later account/member/assignment/email work; those later failures do not undo them. Staff call allowances capture available seconds at start; running calls count elapsed time, not their full remaining allowances (`web/lib/org-credits.ts`; `web/lib/minutes.ts`; `web/lib/interview-sessions.ts`; `web/lib/invite/org.ts`).

## Mismatches

- **People account/member ordering and learner-ledger check:** `web/lib/org-people.ts:143–153` commits starting grants before creating accounts/members; `web/lib/minutes.ts:176–178` has no membership FK/check on these email ledger rows. A later failure leaves an orphan grant/partial batch. Credit shortage itself correctly adds nobody.
- **People rule 11:** org-credit grants are marked announced even without an admin or Resend (`web/lib/org-credits-email.ts:19–40`). **Rule 12:** the announce loop is one retryable step, not one per grant email (`web/workflows/steps/org-credits.ts:19–22`). REST immediate delivery and workflow-startup fallback are allowed exceptions with the original event keys (`web/lib/queue-emails.ts` `deliverEmail`, `queueEmails`); the announce loop is not one of those exceptions.

Legacy ledger rows and some comments still mention top-ups/take-backs. They do not make the ledger the org balance or expose current refund/reclaim helpers (`web/prisma/schema.prisma`; `web/lib/minutes-config.ts`; `web/components/credits/credits-history-table.tsx`).

## Open questions

- Refunds do not take credits back. Operators must adjust Meteroid by hand; when should this be automated? (`web/lib/credit-purchases.ts` `purchaseRefunded`.)
- The Credits plan sets overage to 0.25/min if usage exceeds credits. The app intends to stop at zero; should overage ever be collectible? (`web/scripts/meteroid-setup.ts` `OVERAGE_PER_MINUTE`.)
- Simultaneous call starts are not serialized with grants. Must the available balance reserve whole call allowances rather than elapsed usage? (`web/lib/interview-sessions.ts` `activateSession`; `web/lib/org-credits.ts` `runningSeconds`.)

## Tests today

- Billing boundary: `web/tests/lib/billing-phase-two.db.test.ts` checks paused learner-versus-team additions, no self-serve upgrade and invoice-derived `planCents`. `web/tests/flows/billing-phase-two.flow.test.ts` now uses staff-created non-`Credits` subscription invoices and checks pause/grant/call/resume/pack/no-app-grant cases. Concurrent updates were reread, not run; fake Meteroid/Resend/S3 are not a real payment/credit propagation check. See [Billing code — Tests today](billing-code.md#tests-today).
- DB: `web/tests/lib/org-credits.db.test.ts`, `minutes-ledger.db.test.ts`, `minutes-sessions.db.test.ts`, `minutes-trpc.db.test.ts`, `minutes-stage-two*.db.test.ts` cover arithmetic, fallback, lapsed-grant subtraction/sync, zero-minute expiry events, bounded expiry/funding polling (fake delays, caught-up and exhausted reads), post-recount repeat calls, expired history, webhook, database-only version changes/stability, studio permissions, session charging and parallel grant/cap/starting-minute safety.
- Minimum-start coverage: `web/tests/lib/minutes-sessions.db.test.ts` checks 0/180/299/300-second learner starts, billed admin/team refusal at 299 seconds, acceptance at 300 and resume below 5 minutes. `minutes-learner-page.db.test.ts` covers floored refusal payloads and shared twin/role-play boundaries; `web/tests/components/twin-learner-flow.test.tsx` statically checks disabled start buttons at 0/3/4 versus 5/30 minutes and unmetered preview. The summary button is not exercised by static rendering.
- Unit: `web/tests/lib/meteroid.test.ts`, `org-credits-workflow.test.ts` cover signatures and polling. `org-billing-setup.test.ts` uses MSW for customer/subscription creation/reuse, missing metric/plan, billing upsert, identical trial retry bodies, cancellation/alias move and archive retries/errors. `credit-purchases.db.test.ts` and `flows/credit-purchases.flow.test.ts` assert identical payment retry grant bodies and paidAt-based expiry.
- Flows: `web/tests/flows/trainer-credits.flow.test.ts`, `credits-purchase-practice.flow.test.ts`, `credit-purchases.flow.test.ts` use MSW Meteroid alongside other outside services (`harness.ts`; `web/tests/setup/meteroid.ts`).
- Browser: `web/e2e/credits.spec.ts`, `payments.spec.ts` use a seeded cache and local Meteroid fake (`web/e2e/meteroid.ts`), never real billing. The Credits spec also writes the balance cache directly to simulate an external sync and checks both sidebar and Remaining credits update without navigation/reload (20-second browser budget after route warm-up), restoring the cache afterward. Component tests are server-render-only, so polling effects are covered in the browser. Deleted-script tests were removed.

People/notification tests: `web/tests/lib/org-people.db.test.ts`, `org-credits-email.db.test.ts`, `web/tests/flows/org-people.flow.test.ts` and `web/e2e/people.spec.ts`. Not run for this spec update; no live Meteroid/Resend validation.
