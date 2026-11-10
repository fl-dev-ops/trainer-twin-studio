# People and emails

> Despite this file's old name, org invitations are gone. Adding a person makes them a member immediately. Twin/role-play assignment first adds the learner, then gives account-bound access. Each action builds one combined email per affected person, normally delivered by `send-emails`. Sign-in codes and support alerts use the same Resend sender. Owners: `web/lib/org-people.ts`, `web/lib/invite/*`, `web/lib/email.ts`, `web/lib/queue-emails.ts`. Agreed rules: [People](people.md).

## Who uses it

| Actor | Action / pointer |
| --- | --- |
| Admin/team | Add team or learners in Settings, assign practice, grant learner credits (`web/lib/minutes-trpc.ts`; `web/lib/twin/trpc.ts`; PUT `web/app/api/role-play/[slug]/assignments/route.ts`). |
| Learner | Signs in with an existing account and uses their access (`web/lib/pages/learner.ts`; see [Auth](auth.md)). |
| API integrator | Adds learners and assigns role plays (`web/app/api/v1/users/route.ts`; `web/app/api/v1/assignments/route.ts`). |
| Copilot | Assigns learners, refusing staff recipients (`web/lib/copilot-studio.ts` `inviteLearners`). |
| Operator | Creates founder account/token, prints onboarding URL; no founder email (`web/scripts/founder-invite.ts`). |
| Reporter/support | Saves issue / receives alert (`web/app/api/issues/route.ts`; `web/lib/issue-alerts.ts`). |

## Words used here

| Term | Meaning |
| --- | --- |
| Added person | `AddedPerson`: OrgPerson plus added (new member) and startingCredits (new grant). `web/lib/org-people.ts`. |
| Assignment | Required account/member access, never email alone. Twin uses userId; role play uses memberId (`web/prisma/schema.prisma`). |
| Personal code / common link | `/s/<code>` belongs to a specific assignment / a TwinShareLink can enroll each signed-in account (`web/lib/assignments.ts`; `web/lib/twin-access.ts`). |
| Person email | Parts for added, twin, roleplay, credits in one message (`web/lib/email.ts` `personEmail`). |
| Delivery success | Resend accepted the request, not proof of inbox delivery (`web/lib/email.ts` `sendEmail`). |
| Idempotency key | Event identity passed to Resend; provider deduplicates for 24 hours (`web/lib/email.ts` `SendEmailOptions`). |

## Data

- Org people are `User`/`Member`; [Organizations and roles](orgs-and-roles.md) owns their lifecycle. Assignments require owners and have no recipientEmail. Twin unique `(agentId,userId)`; role play unique `(deploymentId,memberId)` (`web/prisma/schema.prisma`; `20261111120000_people_first/migration.sql`).
- `Invitation` stays as historical data. Migration closes all pending rows as accepted. New Better Auth invite-member requests fail; old `/invite` pages only redirect. There is no awaiting-user pool (`web/lib/auth.ts` `beforeCreateInvitation`; `web/app/auth/invite/page.tsx`).
- `OutboundEmail` is person or orgCredits plus optional idempotencyKey, carried by a workflow, not an app email table. Progress: sent/failed per address, then done with sent count/failed addresses (`web/workflows/send-emails.ts`).
- `OrgBilling.announcedGrantIds` stores announced Meteroid grant IDs. Migration initializes it from existing grants, avoiding historical announcements (`web/lib/org-credits-email.ts`; people-first migration).

## How it works

### Add people, then notify

Settings `minutes.addPeople` accepts team/user and 1–50 normalized valid emails. New learners get optional whole starting minutes 1–360 (default 30). The `add-org-people` workflow calls `addOrgPeople`, then queues emails. Existing members keep roles and count as already; disabled/studio learner recipients are refused for the batch. There is no acceptance step for any role (`web/lib/minutes-trpc.ts`; `web/lib/workflow-runs.ts` `runAddOrgPeople`; `web/workflows/add-org-people.ts`; `web/lib/invite/org.ts`; [Organizations and roles](orgs-and-roles.md)).

`addedEmails` sends only new memberships, key `added:<memberId>`, with actor, org, role and learner balance/starting credits. Learner sign-in link is org home; admin/team is studio (`web/lib/invite/org.ts`; `web/lib/invite/person-email.ts` `personEmailFor`; `web/lib/invite/links.ts` `signInUrl`).

REST POST users calls `addLearnerByApi`, not an invitation writer. It checks enabled key-creator studio membership, calls addPeopleToOrg, and sends a new member's email inline with background retries on failure. It returns 201 new / 200 existing `{user,created,emailSent}`; no email for existing learner. Disabled/studio and shortage are 409; creator missing is 403. GET lists enabled learners and always invitations=[] (`web/app/api/v1/users/route.ts`; `web/lib/invite/org.ts`; see [Public API](public-api.md)).

### Assign twins or role plays

Both write steps call `addPeopleToOrg(role:user)` before assignment; no staff or disabled learner assignment through the normal path. Brand-new learner gets one email containing added, practice and starting credits (`web/lib/invite/twin.ts` `assignTwinLearners`; `web/lib/invite/roleplay.ts` `assignRoleplayLearners`).

| Kind / prior state | Write / email |
| --- | --- |
| Twin absent | Create active by userId, fresh code; email readable `/t/` URL, optional until and current balance. |
| Twin revoked | Reactivate, rotate code, replace end date; email. |
| Twin active (even past end date) | Skip; no date update/email. |
| Role play absent / cancelled / expired | Create or reopen pending by memberId, fresh code/date, clear usedAt; email personal `/s/` URL. |
| Role play pending, resend requested | Same code/date, new time-based email event key. |
| Role play pending without resend / used | Skip, no email. |

Pointers: `web/lib/twin-access.ts` `assignTwin`; `web/lib/invite/twin.ts`; `web/lib/invite/roleplay.ts`. Role-play expiry is stored 30 days ahead but not enforced for pending/used access; twin optional accessUntil gates new starts ([Twins](twins.md), [Role plays](roleplays.md)).

`assign-twin` / `assign-roleplay` workflows queue returned emails once. Counts include joined (new members) and assignment added/reactivated/resent/skipped. REST role-play POST/PATCH uses `learnerFor`: explicit email adds the learner, else enabled org learner userId. Live POST or same-pair PATCH returns unchanged without email; a move rotates link. REST email key is `assignment:<id>:<shareCode>` (`web/lib/workflow-runs.ts`; `web/workflows/assign-{twin,roleplay}.ts`; `web/lib/external-api-assignments.ts`; assignment routes).

Readable Share creates a URL, not enrollment. Opening an active common `/s/` link uses join=true to add the signed-in existing account through addPeopleToOrg, grant starting credits once and create/reuse an assignment, without email. Activation uses join=false and never adds anyone; a nonmember direct start is refused. Disabled common link or revoked/ended existing assignment refuses access (`web/lib/twin/trpc.ts` `agents.shareLink`; `web/lib/twin-access.ts` `twinAccessByCode`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/interview-sessions.ts` `activateSession`).

Copilot filters staff through `studioPeopleEmails`, then invokes the shared helpers for others. It ignores legacy minutes and sends no studio membership invitation. Deleted `assign-session-invite.ts` / `create-session-invite.ts` are no longer entry points (`web/lib/copilot-studio.ts`; commit `1d1ed9f`).

### Grant credits and notify

`give-credits` runs `giveLearnerCredits`: resolve orgPeople including disabled, skip nonmembers/staff/disabled/cap overflow, grant the remaining learners all-or-nothing for org funds, then one credits email per given person. Key `credits:<orgId>:<email>:<request timestamp>`; includes amount and new whole balance (`web/lib/invite/credits.ts`; `web/lib/minutes-trpc.ts` `add`, `addMany`; `web/workflows/give-credits.ts`; [Credits](credits.md)).

`sync-org-credits` refreshes, then its announce step calls `announceNewGrants`. Each positive cached grant not in announcedGrantIds sends the enabled admin an orgCredits email, key `org-credits:<grantId>`, amount, cached balance, expiry/reason and studio credits link. Successful batch pushes IDs. Missing admin or missing Resend also marks IDs announced; other send failures throw and retry the whole announce step (`web/workflows/sync-org-credits.ts`; `web/workflows/steps/org-credits.ts` `announce`; `web/lib/org-credits-email.ts`).

### Templates and links

All templates are in `web/lib/email.ts`; person/org-credit values are HTML-escaped and have plain text versions.

| Sender / subject selection | Contents / link |
| --- | --- |
| sendPersonEmail → personEmail | Subject priority: twin `You can now talk to <name>` → roleplay `New role play: <name>` → added `You've been added to <org> on TrainerTwin` → `<N> credit(s) added to your TrainerTwin account`. Parts include actor, org/role, twin/until, role-play objective/preparation, credits added/balance. Button priority twin → role play → role-based sign-in → none for credits-only. Google/email-code instructions use the recipient address. |
| sendOrgCreditsEmail → orgCreditsEmail | `<N> credit(s) added to <org>`; amount, org balance, optional expiry/reason, credits link. |
| sendOtpEmail | `Your TrainerTwin <purpose> code: <otp>`; purpose defaults Sign In. Better Auth supplies expiring six-digit OTP. Development without Resend prints it to server terminal and returns success; no HTTP exposure. See [Auth](auth.md). |
| sendIssueReportEmail | `Issue reported (<kind>) · <org> · <reporter>` (org optional). Identity/message plus page, session, PostHog event/replay links. `alertIssueReport` sends to devops@foreverlearning.in, CC harini@foreverlearning.in and cathy@foreverlearning.in; logs failures, no reporter acknowledgement (`web/lib/issue-alerts.ts`). |

Links are HTTPS: added learner → `<org>.<base>/`; added studio → `dash.<base>/`; twin → `<org>.<base>/t/<path>`; roleplay → `<org>.<base>/s/<code>`; org credits → `dash.<base>/credits`. Founder script prints `auth.<base>/onboarding?t=<token>` without emailing. Old invitation token redirects by stored role/org, irrespective of status/expiry, or `/sign-in` if unknown (`web/lib/invite/links.ts`; `web/lib/twin-access.ts`; `web/scripts/founder-invite.ts`; `web/app/auth/invite/page.tsx`).

Razorpay separately sends its provider-controlled payment-link notification to supplied payer email (`web/lib/razorpay.ts` `createPaymentLink`, notify.email; [Payments](payments.md)). Password-reset/invitation assignment templates were removed (`web/lib/email.ts`).

### Workflows, retries and progress

`runAndWait` waits for a started workflow's return value (100 ms polling default). Only startup failure calls the same direct helper. People/assignment/credit write steps and queue step have maxRetries=0; PeopleError/MinutesError return a refusal; other errors propagate. A failed started workflow is not rerun inline (`web/lib/workflow-runs.ts`; `web/workflows/steps/learners.ts`).

`queueEmails` starts deliverEmails; empty batch returns zero counts. Started batch returns emailFailures=0, emailsQueued=N and org-signed progress token, not delivery proof. Startup failure sends inline in parallel using each original event key and counts failures. `deliverEmail` (REST) tries inline first so the response can report emailSent; failure queues deliverEmails with the same key and still returns sent=false. Both direct-send paths are allowed by People rule 12; failed retry startup is logged, not a guaranteed delivery (`web/lib/queue-emails.ts` `queueEmails`, `deliverEmail`; `web/lib/send-email-now.ts`).

`deliverEmails` awaits messages in input order. Each sendOne step has maxRetries=4 and key = event key or step ID. Failed provider result throws for retry; missing-key result throws FatalError. Exhausted failure writes failed progress and continues; finish writes done and closes stream (`web/workflows/send-emails.ts`; `web/workflows/steps/send-emails.ts`).

Progress token is run ID plus HMAC-SHA256 signature over org/run with BETTER_AUTH_SECRET. GET `/api/runs/:token` requires studio, returns 404 for invalid/other-org/missing run, streams no-store NDJSON. `followEmailProgress` buffers lines and shows sent/failed/background toasts; it does not undo the action (`web/lib/run-progress.ts`; `web/app/api/runs/[token]/route.ts`; `web/lib/follow-email-progress.ts`).

`sendEmail` loads Resend key at module initialization. Missing key warns and returns false (except development OTP); provider errors/exceptions log and return false. Default sender `RESEND_FROM_EMAIL` or TrainerTwin <no-reply@trainertwin.com>, reply-to support@trainertwin.com, optional CC. No bounce/inbox handler (`web/lib/email.ts`).

## Rules

1. Normal additions are immediate memberships, no invitation acceptance. Better Auth invite-member creation is 403 for every role (`web/lib/auth.ts` `beforeCreateInvitation`; `web/lib/invite/org.ts`).
2. Each new membership/assignment or successful learner grant produces one combined person email, not one message per part. Existing/skipped access produces none; common-link join produces none (`web/lib/invite/{org,twin,roleplay,credits}.ts`).
3. Assignment ownership uses user/member ID only; staff and disabled recipients are refused by addPeopleToOrg. Same role is preserved for existing members (`web/lib/org-people.ts`; `web/lib/assignments.ts`; `web/lib/twin-access.ts`).
4. Starting grants are once per org/email prior-grant history and default 30. Short batch funds block all additions; later failure does not refund committed writes (`web/lib/minutes.ts` `giveStartingMinutes`; `web/lib/org-people.ts`).
5. Email failures leave memberships, access and credits intact and surface through immediate flags, queued progress or logs. Resend keys deduplicate only within the provider's 24-hour window (`web/lib/email.ts`; `web/lib/queue-emails.ts`).
6. Pending role-play resend intentionally creates a new email event while preserving code/date (`web/lib/invite/roleplay.ts`). REST immediate sends and workflow-startup fallback preserve the original event key, as allowed by People rule 12 (`web/lib/queue-emails.ts` `deliverEmail`, `queueEmails`).
7. Org grant announcement excludes known/nonpositive grants; existing migration-time grants are marked known. No admin/missing Resend still consumes announcement IDs (`web/lib/org-credits-email.ts`; people-first migration).

## Entry points

- Settings Team/Users: `web/components/users/{team-section,invite-user}.tsx`; tRPC minutes.addPeople/add/addMany (`web/lib/minutes-trpc.ts`).
- Twin tRPC assignments.assign; PUT `/api/twins/:slug/assignments`; PUT `/api/role-play/:slug/assignments` (1–100 emails); REST POST users and POST/PATCH assignments; copilot inviteLearners. Sources linked above.
- Old GET `/invite?token=...`: `web/app/auth/invite/page.tsx`; now redirect only.
- Email OTP endpoints: `web/lib/auth.ts`; [Auth](auth.md). POST issues: `web/app/api/issues/route.ts`.
- Workflows: `add-org-people`, `assign-twin`, `assign-roleplay`, `give-credits`, `send-emails` (deliverEmails), `sync-org-credits`. Steps: `web/workflows/steps/{learners,send-emails,org-credits}.ts`.
- GET `/api/runs/:token` live delivery progress; `web/scripts/founder-invite.ts` prints founder link; `web/scripts/check-org-people.ts` checks membership/assignment/ledger invariants. Old invite-emails, invite-org-learners, schedule-invite-emails and invitation acceptance helpers are removed.

## Talks to

- [Organizations and roles](orgs-and-roles.md): accounts/members in, AddedPerson out (`web/lib/org-people.ts`).
- [Twins](twins.md), [Role plays](roleplays.md): required owners/access records and learner URLs (`web/lib/invite/twin.ts`, `roleplay.ts`).
- [Credits](credits.md): grants and post-action balances (`web/lib/minutes.ts`; `web/lib/org-credits-email.ts`).
- [Auth](auth.md) / Resend: OTP generation/delivery and sign-in links (`web/lib/auth.ts`; `web/lib/email.ts`).
- Workflow SDK: checkpointed writes/delivery and progress; PostHog/Resend: support alert data; Razorpay: provider payment notification (pointers above).

## Edge cases and limits

- No action/email outbox transaction: failure after grant/member/assignment persistence can leave state without its email payload. Write steps do not retry (`web/lib/org-people.ts`; `web/lib/invite/*`; `web/workflows/steps/learners.ts`).
- Org announcement pushes IDs only after the whole loop. A later failure retries earlier sends using the same grant keys; absent admin/missing key loses notifications instead of deferring them (`web/lib/org-credits-email.ts`).
- Explicit twin-until formatting subtracts twelve hours and formats UTC; correct only UTC−11 through UTC+12 because assigner time zone is not saved (`web/lib/invite/person-email.ts` `lastDay`, shortcut comment).
- Common-link page opening commits joining before its minute check or any later call validation; abandoning prejoin or a failed call does not undo it. Assignment concurrency is DB-unique but ordinary twin/role-play writes lack conflict recovery, unlike common-link joining (`web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/twin-access.ts` `twinAccessByCode`; `web/lib/invite/roleplay.ts`).

## Mismatches

- **People rule 12:** `web/lib/org-credits-email.ts:22–37` loops inline inside one announce step, not one retryable step per email; a failure delays later grants and retries the whole loop (`web/workflows/steps/org-credits.ts:19–22`).
- **People rule 11:** `web/lib/org-credits-email.ts:19–40` marks grants announced with no enabled admin or missing Resend, despite sending no email; later sync will not deliver them. Concurrent announce runs can also reread the same IDs; Resend deduplication lasts only 24 hours (`web/lib/email.ts:16`).
- **People learner-ledger check:** starting grants commit before account/member writes; later persistence failure can leave orphan ledger rows and no added email (`web/lib/org-people.ts:143–159`; `web/lib/minutes.ts:176–178`). Details and script bypasses: [Organizations and roles — Mismatches](orgs-and-roles.md#mismatches).
- Historical `plans/people-and-sign-in.md` §8 says first sign-in creates an account; agreed People rule 10 and current disableSignUp instead refuse unknown accounts (`web/lib/auth.ts`). Users and assignment guides/OpenAPI now describe immediate members and Google/email-code sign-in. The assignment guide's old email subject still differs from personEmail (see [Public API — Mismatches](public-api.md#mismatches); `docs/guides/assignments.mdx`; `web/lib/email.ts` `personEmail`).

- **People rule 11 (at most once per event):** delivery has Resend's 24-hour deduplication only, not a durable sent-event record (`web/lib/email.ts:16`; `web/workflows/steps/send-emails.ts:20`; `web/lib/queue-emails.ts:19,29`). Repeating a lost-response send after that window can deliver the same event again.

- **People rule 11:** existing members newly given their first starting grant can get no email when add/assignment skips them: addedEmails filters added=true (`web/lib/invite/org.ts:22–23`), twin mail only covers new/reactivated access (`web/lib/invite/twin.ts:33–46`), and roleplay pending/used skips (`web/lib/invite/roleplay.ts:67–69`). addPeopleToOrg grants to all requested learners without prior grants, not just fresh members (`web/lib/org-people.ts:145`). This is reachable for backfilled or directly seeded members lacking grants.

## Open questions

- Should final delivery progress be available to REST and inside copilot? REST returns immediate emailSent only; copilot reports background sending but does not follow the token (`web/lib/queue-emails.ts` `deliverEmail`; `web/lib/copilot-studio.ts` `emailsStatus`).
- None about invitation acceptance, passwords, staff-recipient assignment or first-use member binding: [People](people.md) has decided those rules. Listed mismatches are code bugs, not decisions to reopen.

## Tests today

- Unit: `web/tests/lib/person-email.test.ts`, `email-idempotency.test.ts`, `email-otp-delivery.test.ts`, `send-emails-workflow.test.ts`, `send-emails-steps.test.ts`, `queue-emails.test.ts`, `run-progress.test.ts`, `follow-email-progress.test.ts`; route `web/tests/api/runs-progress.test.ts`.
- DB: `web/tests/lib/org-people.db.test.ts`, `invite/org.db.test.ts`, `invite-roleplay-minutes.db.test.ts`, `org-credits-email.db.test.ts`; API `web/tests/api/v1-assignment-email-minutes.db.test.ts`, `people-auth.db.test.ts`.
- Flow/browser: `web/tests/flows/org-people.flow.test.ts`, `web/e2e/people.spec.ts`, credit/practice suites. No tests run for this edit. Captured Resend/workflow mocks do not prove inbox delivery, deployed retries or late retries beyond 24 hours.
