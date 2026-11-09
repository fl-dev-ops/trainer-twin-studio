# Credits

> Prepaid practice time belongs to an organization (org). TrainerTwin adds credits to the org, and the studio gives them to learners. Each learner has one balance across every twin and role play in that org. Calls spend it by the second. Balances come from a ledger of separate movements, plus calls not yet written to that ledger (`web/lib/minutes.ts`).

## Who uses it

| Who | What they can do here |
| --- | --- |
| TrainerTwin staff | Add org credits with `web/scripts/org-topup.ts`; seed existing orgs with `web/scripts/minutes-backfill.ts`. Support can call `reclaimMinutes` for corrections (`web/lib/minutes.ts`). |
| Org admin and team (studio members) | See org and learner balances and histories, choose starting credits, add credits individually or in bulk. Both roles have the same credits permissions and practise without spending credits (`web/lib/trpc.ts` `studioProcedure`; `web/lib/minutes-trpc.ts` `minutesRouter`; `web/lib/interview-sessions.ts` `activateSession`). |
| Learner (role `user`, including an invited person not yet a member) | Receive credits and spend them on calls; see minutes, not credit-management controls (`web/lib/minutes.ts` `giveStartingMinutes`; `web/lib/pages/learner.ts`; see [Learner portal](learner-portal.md)). |
| API integrator | Inviting or assigning a new learner gives the default starting credits. The public API has no general credit-adjustment endpoint (`web/lib/invite/org.ts` `inviteLearnerByApi`; `web/app/api/v1/assignments/route.ts` POST; see [Public API](public-api.md)). |
| Payment processing and voice runtime | Payments append org movements; the voice runtime receives a call deadline and reports the call ending. See [Payments](payments.md) and [Voice agent and chat](voice-agent-and-chat.md). |

## Words used here

| Term | Meaning / code name |
| --- | --- |
| Credit / minute | One credit is one minute of practice, or 60 ledger seconds. Studio headings say “credits”; learners see “minutes”. Studio amounts also use the suffix `min` (`web/components/credits/credits-page.tsx`; `web/lib/minutes.ts`; `web/lib/pages/learner.ts`). |
| Ledger | `MinuteLedger`: signed movements, not a mutable balance counter (`web/prisma/schema.prisma` `MinuteLedger`). |
| Org balance | Credits not yet given to learners, computed by `orgBalanceSeconds`. Not the sum of learners' unused credits. |
| Given / granted | Net grants after take-backs, `grantedSeconds`. Usage does not reduce this total (`web/lib/minutes.ts` `learnerMinutes`). |
| Used / left | `usedSeconds` includes ledger usage and unrecorded call time; `balanceSeconds` is given minus used (`learnerMinutes`). |
| Starting credits | A grant on first invitation, assignment or twin-link join, once per normalized email per org (`giveStartingMinutes`). |
| Take-back | A negative `reclaim` movement returning unused learner credits to the org. Support helper only (`reclaimMinutes`). |
| Metered call / allowance | A call with non-null `InterviewSession.allowedSeconds`: the learner balance captured for that call at activation (`web/lib/interview-sessions.ts` `activateSession`). |

## Data

### `MinuteLedger`

Owned by `web/lib/minutes.ts`. Its application writers append rows; they do not edit old movements. This is an application convention, not a database ban on UPDATE or DELETE. Deleting an organization cascades to its ledger (`web/prisma/schema.prisma` `MinuteLedger`; `web/prisma/migrations/20261107120000_minute_ledger/migration.sql`).

| Field | Meaning |
| --- | --- |
| `id`, `orgId` | Movement ID and required org foreign key. |
| `email` | Lowercase learner identity; null for org top-ups and refunds. Allows credit before an account exists. Helpers trim and lowercase emails. |
| `userId` | Optional account ID, not the balance key. |
| `type`, `seconds` | Movement kind and signed integer seconds; see below. |
| `sessionId` | Present exactly for usage; unique, so one usage row per session. |
| `externalId` | Optional unique payment/refund identifier; required for refunds. |
| `actorUserId`, `note` | Optional person who made the movement and reason. |
| `createdAt` | Creation time; defaults to database current time. |

Sources: `web/prisma/schema.prisma` `MinuteLedger`; `web/lib/minutes.ts` writers. SQL constraints live in the migrations, not Prisma's CHECK metadata.

| `type` | Required sign | Holder | Written by |
| --- | --- | --- | --- |
| `topup` | `seconds > 0` | Org: email null | `topUpOrg` / `orgMovement` |
| `refund` | `seconds < 0` | Org: email null | `refundOrg` / `orgMovement` |
| `grant` | `seconds > 0` | Learner: email required | `grantMinutes`, `giveStartingMinutes`, `grantMinutesToMany` |
| `reclaim` | `seconds < 0` | Learner: email required | `reclaimMinutes` |
| `usage` | `seconds <= 0` (zero allowed) | Learner: email required | `recordSessionUsage` |

The database rejects other types, wrong signs, wrong holders, non-lowercase emails, usage without a session, non-usage with a session, and refunds without `externalId`. Non-null `sessionId` and `externalId` each have a unique index. Sources: `web/prisma/migrations/20261107120000_minute_ledger/migration.sql` and the replacements/additions in `web/prisma/migrations/20261109120000_credit_purchases/migration.sql`.

Movement lifecycle: absent → appended; a correction is another movement, not an edit (`web/lib/minutes.ts` writers).

### Session fields used for metering

`InterviewSession` belongs to [Sessions](sessions.md). Credits reads `orgId`, `userId`, `startedAt`, `endedAt`, `status` and `allowedSeconds`. The allowance is null for unmetered studio calls; otherwise it must be greater than zero (database CHECK). Activation writes it; finalization writes the usage movement (`web/lib/interview-sessions.ts` `activateSession`, `finalizeInterviewSession`; minute-ledger migration).

## How it works

### Read balances

All sums below are in seconds, scoped to one org. Learner sums are also scoped to their normalized email (`web/lib/minutes.ts` `orgBalanceSeconds`, `learnerMinutes`, `learnerBalance`).

```text
org unallocated = SUM(topup.seconds + refund.seconds)
                  - SUM(grant.seconds + reclaim.seconds)
org credits added = SUM(topup.seconds + refund.seconds)
learner given = SUM(grant.seconds + reclaim.seconds)
learner used = -SUM(usage.seconds) + unrecorded call seconds
learner left = learner given - learner used
```

Here each SUM includes rows of the named types; refund and reclaim values are already negative. Usage does not debit the org a second time. `orgCreditsAddedSeconds` gives the org-added total.

For each call without a ledger row for its session, unrecorded call seconds are:

```text
MAX(0, MIN(allowedSeconds, FLOOR((endedAt OR current UTC time) - startedAt)))
```

Only sessions with an allowance and start time count; `failed` and `revoked` do not. This includes running calls and closed calls whose usage has not been recorded. Once the usage row exists, the call is excluded from this extra sum (`learnerMinutes`, its two SQL queries).

Raw balances are not clamped. Studio learner totals and lists floor given/left to whole minutes, clamp displayed left to zero, and show used to one decimal place in `minutesRouter`. `creditsLeftFor` returns whole-minute left/given, zero for unknown learners, and null for studio members (`web/lib/minutes-trpc.ts` `org`, `learner`; `web/lib/minutes.ts` `creditsLeftFor`).

### Fund an org or refund a purchase

1. `topUpOrg` or `refundOrg` validates a positive whole-minute amount and takes the org advisory transaction lock.
2. If the supplied `externalId` already exists, it returns `duplicate: true`, with no row or `alongside` callback. Otherwise it appends a signed movement and runs the optional callback in the same transaction. Failure rolls both back.
3. It returns the current org balance in whole minutes. A refund can make that balance negative; it does not remove learner grants (`web/lib/minutes.ts` `wholeMinutes`, `locked`, `orgMovement`). Purchase events and refund rounding belong to [Payments](payments.md).

Manual top-ups have no external ID and are not retry-idempotent (`web/scripts/org-topup.ts`).

### Give starting credits

1. Invitation/assignment callers pass emails and optionally a chosen amount. Default is 30; chosen amounts must be whole minutes from 1 through 360 (`web/lib/minutes-config.ts`; `giveStartingMinutes`).
2. Under the org lock, trim/lowercase/deduplicate emails and find anyone who has ever had a `grant` row in this org. Those people get nothing more, even if their balance is now zero or all credits were reclaimed.
3. Check the cost for all new people. Insufficient org balance raises `MinutesError` 409 and appends no grants. Otherwise append one grant each, with note “Starting minutes” (`giveStartingMinutes`).
4. Callers then create assignments/invitations and send emails. Credit writes are not rolled back by later assignment or delivery failures. A repeated invitation does not give another starting grant (`web/lib/invite/org.ts` `inviteLearners`; `web/lib/invite/twin.ts` `assignTwinAndInvite`; `web/lib/invite/roleplay.ts` `inviteToRoleplay`). See [Invites and emails](invites-and-emails.md).
5. A common twin-link preview gives nothing. First joining creates access and calls `giveStartingMinutes` with the default, not the legacy link's `minutesPerUser`; an existing assignment is reused (`web/lib/twin-access.ts` `twinAccessByCode`). See [Twins](twins.md).

### Add more, individually or in bulk

- Individual: `minutes.add` rejects studio-member emails, then `grantMinutes` locks the org, checks available org seconds and the learner's net-given cap, appends a grant, and returns learner/org balances. A short org is 409; exceeding the cap is 400. Notes default to “Added by trainer” (`web/lib/minutes-trpc.ts` `assertLearner`, `add`; `web/lib/minutes.ts` `grantMinutes`).
- Bulk: `minutes.addMany` accepts 1–100 emails and one shared amount. It skips studio members. `grantMinutesToMany` normalizes/deduplicates the rest and skips anyone whose net-given total would exceed 360. It returns `given`, `skipped` (email and reason), and `orgBalanceMinutes`. Remaining eligible people all receive credits, or none do if their combined cost exceeds the org balance (409). It does not partly fund an eligible batch (`minutesRouter.addMany`; `grantMinutesToMany`).
- The studio maps 409 to tRPC `CONFLICT`, and other credit validation errors to `BAD_REQUEST`. Both paths validate whole amounts 1–360, email syntax/maximum 320 characters, and an optional trimmed note of at most 200 characters (`web/lib/minutes-trpc.ts` schemas, `minutesCall`).

### Spend credits on a call

1. `activateSession` checks membership in the call's org. Admin/team are unmetered. Other callers are metered and must use voice; metered chat is rejected with 400.
2. Resuming the same active/activating activation returns the existing call and its remaining allowance; it does not grant a fresh allowance.
3. For a new metered call, close all this user's active/activating calls in the same org as abandoned, recording their time. Read the resulting learner balance. If it is zero or negative, reject with 403 and “You've used all your practice minutes. Ask your trainer for more.” Otherwise store it as `allowedSeconds` and return `secondsLeft` (`web/lib/interview-sessions.ts` `activateSession`).
4. `activateInterviewRuntime` passes an absolute `endsAt` to LiveKit, whose metadata calls it `ends_at`. The voice agent ends the room at that deadline. Studio calls have no credit deadline (`web/lib/session-activation.ts`; `web/lib/livekit.ts` `activateLiveKitSession`; `agent/src/agent.py` `seconds_until_end`, `end_at_deadline`). See [Sessions](sessions.md) for the call lifecycle.
5. A finalized call writes `-MAX(0, MIN(allowedSeconds, FLOOR((endedAt-startedAt)/1000)))` to usage. Missing timestamps/allowance, failed calls and revoked calls cost zero. `recordSessionUsage` waits for `endedAt` and an allowance; repeated/concurrent writes ignore Prisma `P2002` (unique conflict), not other errors. Transcript-only finalization does not request usage (`web/lib/minutes.ts` `sessionUsageSeconds`, `recordSessionUsage`; `web/lib/interview-sessions.ts` `finalizeInterviewSession`).

## Rules

1. All credit-management tRPC procedures are studio-only and scoped to the context org. Anonymous callers are unauthorized; learners and signed-in callers without an enabled org membership are forbidden (`web/lib/trpc.ts` `protectedProcedure`, `studioProcedure`; `web/lib/minutes-trpc.ts`).
2. One learner balance is keyed by `(orgId, trimmed lowercase email)`, not assignment or twin. The same email has independent balances and starting eligibility in different orgs (`web/lib/minutes.ts` `learnerMinutes`, `giveStartingMinutes`).
3. Every movement must satisfy the type, sign, holder, lowercase-email, session and refund CHECKs listed in Data. A session allowance is null or positive. The DB does not enforce the 360 cap or a nonnegative balance (`web/prisma/migrations/20261107120000_minute_ledger/migration.sql`; `20261109120000_credit_purchases/migration.sql`; `web/lib/minutes.ts` `grantMinutes`).
4. Top-ups, refunds, grants and reclaims run one at a time per org using `pg_advisory_xact_lock(hashtext('minutes:' + orgId))` inside a transaction. Parallel grants cannot spend the same org credits (`web/lib/minutes.ts` `locked`).
5. Starting credits default to 30; a chosen amount is an integer in 1–360. Starting credit is once per person **by email per org**, based on any prior grant, not once per assignment or calendar period (`giveStartingMinutes`; `web/lib/minutes-config.ts`).
6. A learner may be given at most 360 credits net: grants plus negative reclaims, regardless of how much has been used. Exactly 360 is allowed; usage does not create new grant room. Individual excess is 400; bulk excess skips that person (`grantMinutes`, `grantMinutesToMany`; `MAX_LEARNER_MINUTES`).
7. Granting requires enough unallocated org credit. Ordinary grants cannot overdraw it; refunds can. Bulk grants and starting batches are all-or-nothing for the eligible/new people (`orgMovement`, `grantMinutes`, `giveStartingMinutes`, `grantMinutesToMany`).
8. Studio admin/team calls never consume credits: `allowedSeconds` is null and no usage is recorded. Single studio add refuses studio recipients; bulk add skips them. Low-level ledger helpers themselves do not enforce recipient roles (`activateSession`; `recordSessionUsage`; `minutesRouter.add`, `addMany`).
9. A new learner call replaces that user's other live calls in the same org, across both modules, before determining its allowance. This is application sequencing, not a database uniqueness constraint; simultaneous starts are an open question below (`activateSession`).
10. Running and unrecorded closed calls count toward used time, once only and never beyond their own `allowedSeconds`. A lost end event cannot spend forever. Failed/revoked calls contribute zero (`learnerMinutes`, `sessionUsageSeconds`).
11. A learner is low on credits strictly below 10 displayed whole minutes; exactly 10 is not low. The org warning is different: below 30, the default starting grant (`web/lib/minutes-config.ts`; `web/components/credits/learner-credits.tsx`, `learner-credits-table.tsx`, `sidebar-credits.tsx`; `web/components/users/users-table.tsx`).
12. There is no studio take-back, edit-ledger or set-balance action. `reclaimMinutes` is a support helper; it accepts positive whole minutes, refuses more than unused balance with 400, and appends a negative reclaim (`web/lib/minutes-trpc.ts` router; `web/lib/minutes.ts` `reclaimMinutes`).
13. There is no monthly reset, rollover job or unlimited-learner setting. Balances sum all ledger dates and learner activation requires positive seconds. Studio's unmetered practice is a role exemption, not a purchasable unlimited learner allowance (`orgBalanceSeconds`, `learnerMinutes`; `activateSession`; `web/lib/minutes-config.ts`).

## Entry points

### Studio UI

| Surface | Behavior and source |
| --- | --- |
| `/credits` | Org unallocated balance; warning below the default starting amount; Assigned tab with name/email search and given/used/left, lowest left first; Top-up history tab includes refunds. Studio members are omitted. Registered learners link to `/users/<id>`; others say “Invite pending” (`web/app/dash/credits/page.tsx`; `web/components/credits/credits-page.tsx`, `learner-credits-table.tsx`; `minutesRouter.org`). |
| Sidebar Credits link | Org remaining credits; caution below 30; query stale time 60 seconds (`web/components/credits/sidebar-credits.tsx`). |
| `/users/<id>` | Balance summary, used/given progress, Add credits dialog and Credits history tab. Credits are shared even though the Sessions tab lists twin sessions. Add previews org balance after and remaining grant room; saving errors show a toast (`web/app/dash/users/[id]/page.tsx`; `web/components/users/user-detail-page.tsx`; `web/components/credits/learner-credits.tsx`, `add-credits-dialog.tsx`). |
| `/users` | Credits-left column, low badges, “Low on credits” filter, name/email search and selection for bulk Add credits. Studio rows, if present, show “—” and cannot be selected. Bulk dialog previews eligible/skipped people, total cost and org balance after (`web/lib/learners.ts` `listUsers`; `web/lib/pages/router.ts` `users`; `web/components/users/users-table.tsx`; `web/components/credits/bulk-add-credits-dialog.tsx`). |
| Invite / Assign | Starting credits field defaults to 30; learner invite uses `minutes.invite`, twin assign uses `twin.assignments.assign`, role-play assign passes `startingMinutes` (`web/components/users/invite-user.tsx`; `web/lib/twin/trpc.ts` assignments router; `web/app/api/role-play/[slug]/assignments/route.ts` PUT). |

History tables show date, signed credits, note and added-by (actor name, then email; missing actor displays “TrainerTwin”). Histories fetch at most 200 entries by default, newest first; tables page locally in groups of 20. Learner history includes grants only, not usage/reclaims; org history includes top-ups/refunds (`web/lib/minutes.ts` `creditsAdded`; `web/components/credits/credits-history-table.tsx`, `credits-pager.tsx`).

### Procedures and routes

| Entry | Credit boundary / source |
| --- | --- |
| tRPC `minutes.org`, `minutes.learner` (queries) | Org totals/learners/history; one email's totals and grant history (`web/lib/minutes-trpc.ts`). |
| tRPC `minutes.add`, `minutes.addMany`, `minutes.invite` (mutations) | Single add, bulk add, invite with chosen/default starting credit (`web/lib/minutes-trpc.ts`; mounted in `web/lib/app-router.ts` over `/api/trpc`). |
| tRPC `twin.assignments.assign`; PUT `/api/role-play/[slug]/assignments` | Optional `startingMinutes` 1–360; shared starting-grant helper (`web/lib/twin/trpc.ts`; `web/app/api/role-play/[slug]/assignments/route.ts`). |
| PUT `/api/twins/[slug]/assignments` | Gives default starting credit through `assignTwinAndInvite`; legacy `minutes` input is ignored (`web/app/api/twins/[slug]/assignments/route.ts`). |
| POST `/api/v1/users`; POST `/api/v1/assignments`; PATCH `/api/v1/assignments/[id]` | Default starting credit for a previously uncredited recipient; see [Public API](public-api.md) (`web/lib/invite/org.ts`; `web/app/api/v1/assignments/route.ts`, `[id]/route.ts`). |
| Better Auth learner-invitation hook | `beforeOrgInvitation` gives default credit once; non-learner roles bypass it (`web/lib/invite/org-hooks.ts`). See [Invites and emails](invites-and-emails.md). |
| POST `/api/sessions`; finalization paths | Start snapshots allowance; finalization records usage (`web/app/api/sessions/route.ts`; `web/lib/interview-sessions.ts`). See [Sessions](sessions.md). |

### Staff scripts

Run from `web/`:

- `bun scripts/org-topup.ts --org <slug> --minutes 500 --note "Invoice 42"`: requires an existing org, positive integer minutes and nonempty note; appends a top-up with no actor or external ID and prints the balance. Remote databases require `--production`. Retrying appends again (`web/scripts/org-topup.ts`; `web/scripts/razorpay-script-guard.ts` `isRemoteDatabase`).
- `bun scripts/minutes-backfill.ts [--apply] [--org <slug>] [--production]`: dry-run by default. An org with any ledger row is skipped. Otherwise propose 1,000 org minutes and 60 each to eligible learners. Learners are enabled learner members plus active twin recipients, pending/used role-play recipients and unexpired pending learner invites; normalize/deduplicate and exclude studio/disabled members. If 1,000 cannot cover everyone, write nothing. Apply writes the top-up then separate grants. Remote apply requires `--production` (`web/scripts/minutes-backfill.ts` `learnersOf` and main loop).

## Talks to

- [Payments](payments.md): `web/lib/credit-purchases.ts` calls `topUpOrg`/`refundOrg` with payment/refund external IDs and transactional callbacks. Credits owns ledger effects, not money, invoices or webhook verification.
- [Invites and emails](invites-and-emails.md), [Twins](twins.md), [Role plays](roleplays.md): pass learner emails and optional starting amounts to `giveStartingMinutes`; receive granted-email results or a credit error before continuing. Assignment access is separate from balance (`web/lib/invite/org.ts`, `twin.ts`, `roleplay.ts`; `web/lib/twin-access.ts`).
- [Sessions](sessions.md), [Voice agent and chat](voice-agent-and-chat.md): allowance/remaining seconds go out, ended timestamps and status come back; credits writes usage. LiveKit carries `ends_at`; Python enforces it (`web/lib/session-activation.ts`; `web/lib/livekit.ts`; `agent/src/agent.py`).
- [Learner portal](learner-portal.md): reads balance as whole minutes and displays out-of-minutes views; does not expose ledger controls (`web/lib/pages/learner.ts`, `org-home.ts`).
- [Organizations and roles](orgs-and-roles.md): membership determines studio exemption and management access (`web/lib/trpc.ts`; `activateSession`; `creditsLeftFor`).

## Edge cases and limits

- `MAX_LEARNER_MINUTES` is explicitly a `shortcut:` soft cap: “raise when asked.” It is application validation, not a database CHECK (`web/lib/minutes-config.ts`).
- A grant during a call does not extend that call's stored allowance. A resume uses the original allowance minus elapsed seconds; a later new call can use the new balance (`web/lib/interview-sessions.ts` `activateSession`).
- Repeated starting grants to already-credited people normally succeed without spending. However, for a nonempty input and a **negative** org balance, `giveStartingMinutes` compares even zero required seconds against that negative balance and returns 409 (`web/lib/minutes.ts` `giveStartingMinutes`).
- The backfill uses 60 rather than the ordinary 30. It is not one org-wide transaction: interruption after top-up or some grants leaves rows, so a rerun skips that org instead of finishing it. Per-learner `MinutesError`s are logged and processing continues (`web/scripts/minutes-backfill.ts`).
- “Total practice time” in Users is not billing usage: `summarizeLearners` counts ended sessions, caps each at three hours, and ignores sessions without an end. Its `shortcut:` says to upgrade to ledger connected seconds later (`web/lib/learners.ts` `summarizeLearners`, `listUsers`).
- Ledger history is not a complete statement of every movement: the UI fetches only the latest 200 additions/refunds or grants, and not usage/reclaims (`creditsAdded`). Balances still sum every applicable row.

## Mismatches

- `PRODUCT.md` does not define credit economics, starting amounts or caps. There is no direct product-rule conflict to resolve there.
- `plans/twin-roleplay-db-split.md` §12 describes a separate budget per twin assignment and one role-play attempt with no time limit. Current code uses one org learner balance for both modules and allows repeated role-play practice while credit remains (`web/lib/minutes.ts` `learnerMinutes`; `web/lib/interview-sessions.ts` `activateSession`; `web/lib/pages/learner.ts` `loadSharedSession`; see [Role plays](roleplays.md)).
- `plans/twin-share-link.md` describes granting the link's `minutesPerUser`. `twinAccessByCode` now gives the shared default only to a person without any grant in the org; legacy assignment/link minute fields are not the billing source (`web/lib/twin-access.ts`; `web/lib/minutes.ts`).
- `plans/twin-wiring-and-reliability.md` §2 says assignment minutes allow 1–10,000. Current chosen starting-credit paths enforce 1–360 (`web/lib/twin/trpc.ts` assignments `assign`; `web/app/api/role-play/[slug]/assignments/route.ts`; `giveStartingMinutes`). The generic `DurationInput` still parses up to 10,000, but credit forms/server checks narrow that range (`web/components/duration-input.tsx`; `add-credits-dialog.tsx`; `web/lib/minutes-trpc.ts`).
- The `MinuteLedger` schema's summary formula omits refunds; current `orgBalanceSeconds` and `orgCreditsAddedSeconds` include them (`web/prisma/schema.prisma` comment above `MinuteLedger`; `web/lib/minutes.ts`).
- `creditsAdded` and history comments call the record “full” or say rows add up to everything added. Actual reads default to 200 rows, and learner history hides take-backs (`web/lib/minutes.ts` `creditsAdded`; `web/components/credits/credits-history-table.tsx`).

## Open questions

- Must “one live call per learner per org” hold under simultaneous starts with different activation keys? `activateSession` closes previous calls and reads balance outside the session-creation transaction; it does not take `locked`'s org lock. Two starts can both pass that sequence. `InterviewSession` has no unique live-call constraint (`web/lib/interview-sessions.ts` `activateSession`; `web/lib/minutes.ts` `locked`; `web/prisma/schema.prisma` `InterviewSession`).
- Should a learner with 1–59 seconds left be able to start? Activation accepts any positive second balance, but shared-session pages floor it to zero and show out-of-minutes; `twinAccessFor` rejects below 60 seconds (`web/lib/interview-sessions.ts` `activateSession`; `web/lib/pages/learner.ts` `loadSharedSession`, `twinAccessFor`).
- Should support be allowed to reclaim unused credit during a live call? `reclaimMinutes` checks current balance including elapsed usage, but does not shorten the call's previously captured allowance. The call can later consume seconds that have been reclaimed (`web/lib/minutes.ts` `reclaimMinutes`, `learnerMinutes`; `web/lib/interview-sessions.ts` `activateSession`).

## Tests today

These are source coverage, not a claim that the suites were run for this spec.

| Layer | Existing coverage |
| --- | --- |
| Unit (`web/tests/lib`) | `minutes-livekit.test.ts`: deadline metadata for both kinds, studio no-deadline, existing-room refresh. `duration-input.test.ts`: whole-minute parsing and stepping. |
| Database (`web/tests/lib`) | `minutes-ledger.db.test.ts`, `minutes.db.test.ts`: conservation, validation/CHECKs, cap, reclaim, starting idempotency, concurrent ledger movements, org separation, history. `minutes-sessions.db.test.ts`: running/closed usage, allowance cap, failed/revoked zero cost, finalize idempotency, zero balance, studio exemption, replacing live calls, resume deadlines. |
| Database: management and callers | `minutes-trpc.db.test.ts`, `minutes-stage-two-trpc.db.test.ts`: role checks, errors, no take-back procedure, single/bulk/invite input and behavior. `minutes-stage-two.db.test.ts`: chosen starting amounts, bulk skip/atomicity/concurrency. `minutes-entrypoints.db.test.ts`, `minutes-stage-two-entrypoints.db.test.ts`: invitations, assignments and link joins. `minutes-stage-two-lists.db.test.ts`, `minutes-learner-page.db.test.ts`: shared displayed totals, staff nulls, low constant, sub-minute handling. `minutes-backfill.db.test.ts`: dry run/apply/skip, eligibility, insufficient seed and remote guard. |
| Database: public API / payments | `web/tests/api/v1-minutes.db.test.ts`, `v1-assignment-email-minutes.db.test.ts`: default grants, short balances, repeats and emails. `web/tests/lib/credit-purchases.db.test.ts`: refund CHECKs, external-ID idempotency, atomic callbacks and negative org balance. |
| Flows (`web/tests/flows`) | `trainer-credits.flow.test.ts`: funding → chosen invite/assign → single/bulk add → usage. `org-topup.flow.test.ts`: append-only manual funding, validation and remote guard. `credits-purchase-practice.flow.test.ts`: paid funding → practice/resume/repeat → refund. |
| Browser (`web/e2e`) | `credits.spec.ts`: balances, search, pagination, history. `trainer-credits.spec.ts`: individual add/history/cap, bulk preview/add/low filter and chosen starting credits in invite/twin/role-play forms. |
| Python (`agent/tests`) | `test_minutes_limit.py`: deadline parsing/remaining seconds, expired deadlines and goodbye timing/copy. This tests helpers, not a real room closing at the deadline. |

DB suites use a local-database guard (`web/tests/lib/minutes-test-db.ts`); a skipped run is not evidence the DB rules passed. Important gaps in the listed tests: concurrent call starts with different activation keys, reclaim while a call is live, interrupted-backfill recovery, and actual LiveKit deadline teardown. These correspond to the code limits above, not additional implemented guarantees.
