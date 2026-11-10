# Credits

> One credit is one minute of practice. Meteroid owns the org's credits; TrainerTwin owns learners' minutes. Giving minutes to learners spends org credits immediately. Admin/team voice calls spend org credits directly when the org is billed. Learner calls spend only the minutes already given to that learner. (`web/lib/org-credits.ts`; `web/lib/minutes.ts`; `web/lib/interview-sessions.ts`.)

## Who uses it

| Who | What they can do | Code |
| --- | --- | --- |
| TrainerTwin staff | Configure Meteroid, link an org and grant promotional credits; sell packs through [Payments](payments.md). | `web/scripts/meteroid-setup.ts`, `meteroid-link-org.ts` |
| Admin / team | See org credits and grant learners minutes, singly or in bulk. Their billed voice calls use org credits, not personal grants. | `web/lib/minutes-trpc.ts`; `web/lib/interview-sessions.ts` |
| Learner | Uses their shared org/email balance for twin and role-play voice calls. | `web/lib/minutes.ts` `learnerBalance`; `web/lib/interview-sessions.ts` |

## Words used here

- **Billed org:** has an `OrgBilling` row. No row means zero org credits and free staff calls (`web/lib/org-credits.ts` `orgCredits`; `web/lib/interview-sessions.ts` `activateSession`).
- **Grant:** in Meteroid, credits added to an org with optional expiry; in `MinuteLedger`, minutes given to a learner. These are distinct records (`web/lib/meteroid.ts` `CreditGrant`; `web/lib/minutes.ts` `grantMinutes`).
- **Pending spending:** app spending not yet included in Meteroid's `as_of` balance (`web/lib/org-credits.ts` `uncountedSeconds`).

## Data

`OrgBilling` holds `orgId`, unique `meteroidCustomerId`, cached `balanceMinutes`, `balanceAsOf`, `grants` JSON and `syncedAt`. Org deletion cascades. `InterviewSession.chargesOrg` identifies staff sessions whose allowance spends org credits (`web/prisma/schema.prisma`; `web/prisma/migrations/20261110120000_org_credits_meteroid/migration.sql`).

`MinuteLedger` remains append-only, in seconds, scoped to org and normalized email. New app writes are positive learner `grant`, nonpositive learner `usage`, or nonpositive staff `org_usage`. Usage requires a unique session ID. `meteroidSentAt` records reporting to Meteroid. Old `topup`, `refund`, `reclaim` rows remain historical; no current helper creates them. The migration marks pre-existing learner grants sent at their creation time, so they are not re-reported (`web/lib/minutes.ts`; migration above).

Learner balance is signed learner ledger movements (including historical reclaims) minus elapsed unrecorded learner calls, each capped at its allowance. Staff `org_usage` rows and `chargesOrg` sessions do not debit a learner (`web/lib/minutes.ts` `learnerMinutes`).

## How it works

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

Starting grants normalize/deduplicate emails, apply only when no prior grant exists for org/email and are all-or-nothing for a batch. Re-inviting does not replenish spent minutes. Default is 30; chosen amounts are positive whole minutes, at most 360. Ordinary grants cannot exceed 360 minutes given in total (historical reclaims reduce that total; usage does not). Bulk additions skip people who cannot fit the chosen amount, then require enough org credits for everyone remaining. Successful writes schedule usage reporting (`web/lib/minutes.ts`; `web/lib/minutes-config.ts`).

### Calls

Learner voice activation requires positive personal seconds; learner chat is refused. Staff voice activation reads fresh org credits: billed and positive sets `chargesOrg=true` and `allowedSeconds` to available org seconds; billed at zero refuses with `MinutesError` 403 and `ORG_OUT_OF_CREDITS`. Staff chat and unbilled staff voice remain unmetered (`web/lib/interview-sessions.ts` `activateSession`).

Finalization floors elapsed seconds, clamps to zero/allowance and records one row per session. `chargesOrg` selects `org_usage`; otherwise metered sessions write `usage`. Repeated/parallel finalization cannot double-charge; positive staff usage schedules reporting (`web/lib/minutes.ts` `sessionUsageSeconds`, `recordSessionUsage`).

### Send and refresh

`sendOrgUsage` sends up to 500 unsent grant/staff rows, one `voice_minutes` event per row, using the row ID as event ID. Properties include decimal minutes (absolute seconds/60), kind (`given_to_learner` or `staff_call`), email and optional session. Only after successful ingestion are rows marked sent. Repeating does not resend marked rows; Meteroid deduplicates event IDs if sending succeeded before marking failed (`web/lib/org-credits.ts`; `web/lib/meteroid.ts` `sendUsage`).

`reportOrgUsage` sends once, then polls refresh up to 20 times with 3-second sleeps until Meteroid's `as_of` is strictly later than sentAt. `syncOrgCredits` only refreshes.

`refreshOrgCredits` reads MINS grants and balance. For grants expired after that balance's `as_of`, it sends one zero-minute `voice_minutes` event per grant: ID `expired-<grantId>`, `properties.minutes = "0"`, kind `recount_after_expiry`, and `grant = <grantId>`. Meteroid deduplicates these IDs. Meteroid also sends `wallet.funded` before `wallets/check` includes the new grant (about two seconds later, verified live). Refresh re-reads balance while any grant is lapsed relative to `as_of` **or** has `createdAt > as_of`: up to five re-reads, waiting two seconds before each (at most ten seconds of sleeps). It stops when both conditions clear; grants created at/before `as_of` or without a creation time alone cause no wait. It stores the last balance/as_of, grants (including expired history) and sync time even if still behind; `orgCredits` still applies the conservative expiry subtraction then. A newly funded grant may remain invisible in the balance until a later sync if all five re-reads stay behind. After recount, subsequent refreshes send no expiry events. `counted` still only compares `as_of > sentAt` (or is true without `sentAt`); it is not an expiry-recount success flag.

Schedulers log errors and never throw; unsent rows remain recoverable on later spending or a stale Credits page (`web/workflows/org-credits.ts`, `org-credits-steps.ts`; `web/lib/schedule-org-credits.ts`).

Assignment emails are a separate workflow, queued only after starting grants and assignment writes. Queued `emailFailures: 0` is not delivery confirmation; the studio follows an org-signed NDJSON progress token. Startup failure falls back to inline sending, and send failures never refund grants or remove assignments. Public REST assignment sends remain inline. See [Invites and emails — Assignment email workflow and progress](invites-and-emails.md#10-assignment-email-workflow-and-progress) (`web/lib/invite/twin.ts`, `roleplay.ts`; `web/lib/schedule-assignment-emails.ts`).

### Live studio refresh

The studio sidebar polls studio-only `minutes.version` every five seconds. This opaque string fingerprint reads only `OrgBilling.balanceMinutes`, grant IDs/statuses and the newest org `MinuteLedger` row ID: no Meteroid call. Repeated reads without those changes are stable; giving learner credits, recording staff `org_usage`, or changing the cached balance/grant status changes it (`web/lib/minutes-trpc.ts`).

The first value establishes a baseline without invalidation. Each changed value invalidates `minutes.org`, `page.credits`, `minutes.learner` and `page.users`, so mounted credit displays (including the sidebar and Remaining credits card) update without a reload, normally within one five-second polling interval after the database sync. Polling does not itself sync Meteroid, and background-tab timer throttling/network delays can extend that time (`web/components/credits/sidebar-credits.tsx` `useLiveCredits`).

## Rules

1. The org's balance is not a sum of `MinuteLedger` org top-ups or learners' unused minutes (`web/lib/org-credits.ts`).
2. Only admin/team may manage credits. Staff cannot receive learner grants; their calls spend the org's credits directly (`web/lib/minutes-trpc.ts` `assertLearner`, procedures).
3. There is no take-back/set-balance procedure or current reclaim helper (`web/lib/minutes-trpc.ts`; `web/lib/minutes.ts`).
4. `creditsAdded(orgId, email)` requires an email and returns learner grants only, newest first, default limit 200, with actor name/email/null (`web/lib/minutes.ts`).
5. `minutes.org` returns `{ billed, balanceMinutes, addedMinutes, defaultMinutes, maxMinutes, grants, learners }`, not `topups`. Added minutes sum cached Meteroid grants, including expired ones. History notes combine reason with `expires d Mon yyyy` or `expired d Mon yyyy`; staff are excluded from learners. Copies older than 60 seconds refresh and schedule any unsent usage (`web/lib/minutes-trpc.ts`).

## Entry points

- `/credits`, learner dialogs and users/assignment grant forms: `web/components/credits/*`; `web/lib/minutes-trpc.ts` (`org`, `version`, `learner`, `add`, `addMany`, `invite`).
- Invites and assignment/link joins use starting grants: `web/lib/invite/*`; `web/lib/twin-access.ts`; `web/app/api/v1/users/route.ts`, `assignments/route.ts`.
- `bun scripts/meteroid-setup.ts` configures MINS, the SUM `voice_minutes` metric and Credits plan. `bun scripts/meteroid-link-org.ts --org <slug>` links the customer/subscription; optional `--minutes`, `--expires`, `--reason`, `--grant-key` grant promotional credits. Remote writes require `--production` and non-sandbox keys; local requires `pv_dev_…` (`web/scripts/meteroid-setup.ts`, `meteroid-link-org.ts`).
- POST `/api/meteroid/webhook`: Standard Webhooks signature, ±300 seconds, HMAC-SHA256 over `id.timestamp.body`, base64 key after `whsec_`. Valid wallet funded/debited/depleted/recovered and credit_grant.expired events schedule sync; customer may be top-level or under data. Unknown types/customers return ignored 200; bad signatures return 401 (`web/app/api/meteroid/webhook/route.ts`; `web/lib/meteroid.ts` `verifyWebhook`).

## Talks to

Meteroid REST uses `METEROID_API_URL` (default `https://meteroid-rest.foreverlearning.in/api/v1`) and Bearer `METEROID_API_KEY`. Wallet check uses `credit_unit=MINS`; grants list uses `per_page=100`; ingestion is POST `/events/ingest`. `METEROID_WEBHOOK_SECRET` verifies callbacks. Razorpay purchases create PAID Meteroid grants; see [Payments](payments.md) (`web/lib/meteroid.ts`; `web/lib/credit-purchases.ts`).

## Edge cases and limits

Observed live on the Meteroid 2.2.1 dev tenant: `wallets/check` retains expired grant credits until the next usage recount, and Meteroid sends **no** `credit_grant.expired` webhook. A zero-minute event triggers a recount in about three seconds; merely refreshing the wallet does not. The webhook route accepts expiry events if supplied but cannot rely on them. The local subtraction and recount above compensate for this quirk (`web/lib/org-credits.ts` `lapsedSince`, `refreshOrgCredits`).

Meteroid grants list is one page, usage sending one batch. Cached fallback is available only for linked orgs and still subtracts lapsed grants and pending app spending. Starting grants commit before later invitation/email work; those later failures do not undo them. Staff call allowances capture available seconds at start; running calls count elapsed time, not their full remaining allowances (`web/lib/org-credits.ts`; `web/lib/minutes.ts`; `web/lib/interview-sessions.ts`; `web/lib/invite/org.ts`).

## Mismatches

Legacy ledger rows and some comments still mention top-ups/take-backs. They do not make the ledger the org balance or expose current refund/reclaim helpers (`web/prisma/schema.prisma`; `web/lib/minutes-config.ts`; `web/components/credits/credits-history-table.tsx`).

## Open questions

- Refunds do not take credits back. Operators must adjust Meteroid by hand; when should this be automated? (`web/lib/credit-purchases.ts` `purchaseRefunded`.)
- The Credits plan sets overage to 0.25/min if usage exceeds credits. The app intends to stop at zero; should overage ever be collectible? (`web/scripts/meteroid-setup.ts` `OVERAGE_PER_MINUTE`.)
- Simultaneous call starts are not serialized with grants. Must the available balance reserve whole call allowances rather than elapsed usage? (`web/lib/interview-sessions.ts` `activateSession`; `web/lib/org-credits.ts` `runningSeconds`.)

## Tests today

- DB: `web/tests/lib/org-credits.db.test.ts`, `minutes-ledger.db.test.ts`, `minutes-sessions.db.test.ts`, `minutes-trpc.db.test.ts`, `minutes-stage-two*.db.test.ts` cover arithmetic, fallback, lapsed-grant subtraction/sync, zero-minute expiry events, bounded expiry/funding polling (fake delays, caught-up and exhausted reads), post-recount repeat calls, expired history, webhook, database-only version changes/stability, studio permissions, session charging and parallel grant/cap/starting-minute safety.
- Unit: `web/tests/lib/meteroid.test.ts`, `org-credits-workflow.test.ts` cover signatures and polling.
- Flows: `web/tests/flows/trainer-credits.flow.test.ts`, `credits-purchase-practice.flow.test.ts`, `credit-purchases.flow.test.ts` use MSW Meteroid alongside other outside services (`harness.ts`; `web/tests/setup/meteroid.ts`).
- Browser: `web/e2e/credits.spec.ts`, `payments.spec.ts` use a seeded cache and local Meteroid fake (`web/e2e/meteroid.ts`), never real billing. The Credits spec also writes the balance cache directly to simulate an external sync and checks both sidebar and Remaining credits update without navigation/reload (20-second browser budget after route warm-up), restoring the cache afterward. Component tests are server-render-only, so polling effects are covered in the browser. Deleted-script tests were removed.
