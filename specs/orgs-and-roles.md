# Organizations and roles

> An org is a training workspace. A person has an account, then a membership with a role, then learner assignments. Settings adds members immediately; there is no invitation to accept. `web/lib/org-people.ts` supplies the org's people. Studio access, disabling and staff role changes live in `web/lib/org.ts`, `web/lib/trpc.ts` and `web/lib/members.ts`. The agreed rules are in [People](people.md); differences are listed below.

## Who uses it

| Actor | What they do / pointer |
| --- | --- |
| Admin (`admin`) | Runs the studio; cannot be disabled or change role (`web/lib/members.ts` `setMemberDisabled`, `changeMemberRole`). |
| Team (`team`) | Same studio permissions as admin; adds people and disables non-admin people other than themself (`web/lib/auth-roles.ts` `organizationRoles`; PATCH `web/app/api/members/[id]/route.ts`). |
| Learner (`user`) | Uses the portal and their own account settings, not studio loaders (`web/lib/pages/router.ts`; `web/app/dash/settings/page.tsx`). |
| API / copilot | Acts for a studio member to add learners and assign practice (`web/lib/external-api.ts` `requireExternalApi`; `web/lib/copilot-studio.ts` `runCopilotStudio`). |
| Staff / founder | Staff changes team ↔ learner with the script; operator-created founder uses a token to create org/admin (`web/scripts/set-member-role.ts`; `web/lib/onboarding.ts` `foundOrg`). |

## Words used here

| Term | Meaning |
| --- | --- |
| Account | `User`: shared name, email and identity across orgs. |
| Member / person | `Member`: account's role and disabled state in one org; exposed as `OrgPerson`. |
| Studio | Exactly admin/team; `web/lib/roles.ts` `isStudioRole` (re-exported by `org.ts`). |
| Learner | Database role `user`; public API calls it `member` (`web/lib/external-api.ts` `API_LEARNER_ROLE`). |
| Active org / pin | Login session preference / tab's `x-trainertwin-org` header. Neither grants access (`web/lib/org.ts` `currentMembership`; `web/lib/org-pin.ts`). |
| Portal org | Org named by learner host, independent of studio selection (`web/lib/session-user.ts` `resolveSessionUser`). |
| People lock | PostgreSQL transaction advisory lock `people:<orgId>`; adding also takes `minutes:<orgId>` first (`web/lib/db.ts` `withLock`; `web/lib/org-people.ts` `peopleLock`; `web/lib/minutes.ts` `minutesLock`). |
| Assignment | Access to a twin or role play, not membership or credits; see [Twins](twins.md), [Role plays](roleplays.md). |

## Data

| Record | Fields and writers |
| --- | --- |
| `Organization` | Unique slug, name, logo, website, JSON-text metadata, Chroma settings. foundOrg creates; updateOrgSettings writes branding, not slug/staff flags (`web/prisma/schema.prisma`; `web/lib/onboarding.ts`; `web/lib/org.ts`). |
| `User` | Unique email, name, image, emailVerified. accountsFor creates missing accounts with lower-case email, name before `@`, unverified; operator creates founders (`web/lib/org-people.ts`; `web/scripts/founder-invite.ts`). |
| `Member` | Required user/org, role default user, createdAt, nullable disabledAt; unique `(organizationId,userId)`. addPeopleToOrg creates; onboarding creates admin; setMemberDisabled and changeMemberRole update under people lock (`web/prisma/schema.prisma`; `web/lib/org-people.ts`; `web/lib/members.ts`). |
| `Invitation` | Historical only. Migration closes pending rows; old URLs read role/org to redirect (`20261111120000_people_first/migration.sql`; `web/app/auth/invite/page.tsx`). |
| Auth `Session` | Active-org preference and login token, not practice session. Better Auth writes; disabling last enabled membership deletes logins (`web/lib/auth.ts`; `web/lib/members.ts`). |

Role CHECK permits only admin/team/user (`web/prisma/migrations/20261027010000_org_roles/migration.sql`). The people-first migration merges duplicate members, backfills accounts/members from old assignment emails and invitations, requires assignment owners and deletes studio-held learner assignments. Twins have a composite `(orgId,userId)` FK to member; role plays require memberId. The new partial unique index allows **at most** one admin per org; it fails on existing duplicates, rather than repairing them. Exactly one is checked separately (`web/prisma/migrations/20261111120000_people_first/migration.sql`; `20261114120000_one_admin_per_org/migration.sql`; `web/scripts/check-org-people.ts` `PEOPLE_CHECKS`).

Membership: absent → enabled → disabled → enabled. Role: user ↔ team through staff script only; admin stays admin. Becoming team deletes learner assignments in the role transaction; session history remains, with assignment references cleared by FKs (`web/lib/members.ts` `changeMemberRole`; `web/prisma/schema.prisma`).

## How it works

### Add and list people

1. orgPeople(orgId, filter, tx?) returns oldest first (createdAt, ID), excluding disabled by default. Filters: roles, emails (case-insensitive), userIds, memberIds. orgPerson returns one by account/member/email including disabled; studioPeopleEmails includes disabled admin/team (`web/lib/org-people.ts`).
2. addPeopleToOrg trims/lowercases/deduplicates emails, drops empty values and refuses malformed emails with invalid_email/400. In one transaction it takes minutes then people lock, rereads existing members and refuses disabled recipients (person_disabled/409), learner actions for studio recipients (person_is_studio/409), and a fresh second admin (one_admin/409). Existing members keep their role (`web/lib/org-people.ts:126–151`; `web/lib/db.ts` `withLock`).
3. Only **fresh learner memberships** are candidates for starting credits. giveStartingMinutes runs in that transaction, once per org/email prior-grant history. Then accountsFor creates missing accounts (createMany/skipDuplicates and reread handles cross-org account creation), and createMany inserts members. Grants, accounts and members commit together or all roll back; shortage adds nobody. After commit, scheduleOrgUsage reports grants. Assignments and email preparation happen later, outside this transaction (`web/lib/org-people.ts:152–187`; `web/lib/minutes.ts` `giveStartingMinutes`; [Credits](credits.md)).
4. Settings calls studio-only minutes.addPeople (team/user, 1–50 emails, optional whole minutes 1–360), then runAddOrgPeople. The workflow adds people and queues one combined email per new member; existing members count as already and receive no added email (`web/lib/minutes-trpc.ts`; `web/lib/workflow-runs.ts`; `web/workflows/add-org-people.ts`; `web/lib/invite/org.ts` `addOrgPeople`).
5. Settings reads orgPeople(includeDisabled:true), Team/Users groups and counts from those rows. Users includes disabled learners, pickers only enabled learners and API lists only enabled learners; role-play Users also includes studio members with historical practice (`web/lib/pages/router.ts` `settings`; `web/components/users/team-section.tsx`; `web/lib/learners.ts`; `web/lib/roleplay/trpc.ts` `users.list`).

### Work in and switch orgs

currentMembership rereads enabled memberships even with a cached login. A nonempty pin must name an enabled studio membership, else org_pin_invalid; it never silently switches a pinned tab. Without a pin, pickMembership prefers active studio → oldest studio → active other → oldest other. Signed out returns null; no enabled membership returns no_org. studioRefusal adds signed_out/studio_only as needed; studioOrg throws it, studioOrRefusal returns its HTTP response, getTrainerOrg converts AppError to null for yes/no callers (`web/lib/org.ts:53–130`).

The dash switcher lists enabled studio orgs. OrgPin wraps same-origin fetch, preserving explicit pins and leaving cross-origin fetch alone. Switching calls Better Auth setActive, then reloads with pathAfterOrgSwitch: section/list URLs keep query; record URLs truncate to their list. Other tabs keep their fetch pin; document requests use active org (`web/components/org-switcher.tsx`; `web/components/org-pin.tsx`; `web/lib/org-switch-path.ts`).

Studio page loaders use studioProcedure, including overview/talk/voices/developer/twinKnowledge. Settings alone uses protectedProcedure: learners get user only, null organization/team and Account/sign-out; query tabs team/branding/billing fall back to Account. Knowledge management and TTS voice-library routes use studioOrRefusal; some read/search/TTS routes still lack studio checks (Mismatches). Server layout guards redirect rather than return a refusal body (`web/lib/pages/router.ts`; `web/app/dash/settings/page.tsx`; `web/app/api/knowledge/[[...kb]]/route.ts`; `web/app/api/tts/voices/route.ts`; `web/lib/org.ts` `requireStudioMember`).

Portal identity chooses host org, not pin; identity alone proves no membership. Common twin-link page opening calls addPeopleToOrg for a signed-in existing account, grants once and creates/reuses access, with no email. Session activation never adds a member. visibleSessions reads orgPerson: enabled studio sees all same-org undeleted sessions, enabled learner only their own, absent/disabled sees none. Detail's web-login fallback and audio/video use this filter; detail also accepts a runtime token ([Auth](auth.md), [Sessions](sessions.md); `web/lib/session-user.ts`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/twin-access.ts` `twinAccessByCode`; `web/app/api/sessions/[id]/{route.ts,audio/route.ts,video/route.ts}`).

### Disable, re-enable and change role

PATCH `/api/members/:id` requires studio, strict `{disabled:boolean}`, and same-org member. AppError responses preserve code/status/message: invalid_input/400, not_found/404, admin_fixed/403, self_disable/400 (`web/app/api/members/[id]/route.ts`; `web/lib/members.ts`).

setMemberDisabled takes people lock and rereads the member. Re-enable clears disabledAt only. First disable timestamps member, revokes active twins, cancels pending role plays, revokes assigned sessions and clears runtime tokens in one transaction. It deletes DB logins only with no other enabled membership. After commit (also for repeat disable), it attempts all activating/active call endings with Promise.allSettled; failures produce AggregateError after the others are attempted. closeInterviewSession finalizes the row then starts an end workflow; physical room closure is asynchronous (`web/lib/session-lifecycle.ts`; `web/lib/session-end.ts`). Past sessions, used role plays, credits and other orgs remain (`web/lib/members.ts:36–67`).

changeMemberRole accepts only team/user, refuses missing person/admin, returns unchanged for same role and changes role under people lock. Becoming team deletes both learner-assignment kinds in that transaction; becoming learner gives no automatic assignments/starting grant. Script requires email, team|user and orgSlug, and reports before/after; no page/API role-change action exists. Better Auth HTTP member routes are closed; server invite/add/remove/update-role hooks refuse member_action_closed (leave is a mismatch) (`web/lib/members.ts:75–88`; `web/scripts/set-member-role.ts`; `web/lib/auth.ts:75–82`; [Auth](auth.md)).

### Onboarding and branding

foundOrg spends the founder token with org/admin creation, then provisions Chroma/Meteroid/trial. A failed provisioning undo returns token only if cleanup completes; later active-org/connector errors never delete a successful org. See [Auth](auth.md) (`web/lib/onboarding.ts`; `web/app/api/onboarding/route.ts`).

Account name is shared; email read-only. OrganizationForm sends **one PATCH** with name/logo/website/accent. Route requires studio and a strict body: trimmed name 1–80, nullable string logo, HTTPS-or-empty website ≤2048 and #RGB/#RRGGBB accent; bad schema is invalid_input/400. updateOrgSettings checks nonempty logo's data-URL type/decoded size, then saves all fields in one update. Empty website becomes null; null logo removes it. Slug and readable object metadata keys survive; malformed/nonobject metadata becomes {}. hideRoleplay is staff-set, not a permitted body field (`web/components/profile-form.tsx` `OrganizationForm`; `web/app/api/org/settings/route.ts`; `web/lib/org.ts` `orgMetadata`, `isValidLogo`, `updateOrgSettings`).

## Rules

1. One member per org/account; assignments require a member and access matches account, not email (`web/prisma/schema.prisma`; people-first migration; `web/lib/assignments.ts` `assignmentMatchesUser`; `web/lib/twin-access.ts`).
2. Adds, disable/re-enable and role changes serialize on people lock; adds also hold minutes lock and commit starting grants/accounts/members together. Existing members get neither role changes nor starting grants through add (`web/lib/org-people.ts` `addPeopleToOrg`; `web/lib/members.ts`).
3. Admin/team have equal configured studio permissions, no org-delete permission. Studio loaders refuse learners; own Settings is the exception. Route guard gaps are below (`web/lib/auth-roles.ts`; `web/lib/roles.ts`; `web/lib/pages/router.ts`; `web/lib/trpc.ts`).
4. tRPC protectedProcedure requires enabled membership, studioProcedure adds role check. AppError retains tRPC status/message and carries its code in data.refusal; schema/legacy errors differ below (`web/lib/trpc.ts:54–79`; `web/lib/errors.ts` `toTRPCError`).
5. Only metadata hideRoleplay === true hides menus, roleplay layouts and home assignments. It does not revoke links or gate every API/catalog (`web/lib/org.ts`; `web/lib/pages/org-home.ts`; `web/lib/roleplay/trpc.ts`).
6. Disable preserves history, cannot target admin/self; repeat disable retries leftover calls. New login is refused only when all memberships are disabled. Re-enable restores membership only (`web/lib/members.ts`; `web/lib/auth.ts` session-create hook).
7. Role changes are staff team ↔ learner only, with assignment deletion on becoming team; admin stays fixed (`web/lib/members.ts` `changeMemberRole`; `web/scripts/set-member-role.ts`).
8. API org is key-selected; every request checks enabled admin/team creator, never chooses another trainer. See [Public API](public-api.md) (`web/lib/external-api.ts`).

### Refusals

See [People — Refusals](people.md#refusals) for codes, statuses, messages and required layers. Shared errors are `web/lib/errors.ts`; people/member factories are `web/lib/org-people.ts` `peopleRefusals` and `web/lib/members.ts` `memberRefusals`.

## Entry points

- Settings/Users/pickers: `web/app/dash/settings/page.tsx`, `web/components/users/{team-section,invite-user}.tsx`, `web/lib/pages/router.ts`, `web/lib/learners.ts`.
- Studio tRPC minutes.addPeople/add/addMany/org/version/learner, twin.*, roleplay.*; `web/app/api/trpc/[trpc]/route.ts`, `web/app/api/twin/[[...route]]/route.ts`, `web/app/api/roleplay/[[...route]]/route.ts`.
- PATCH `/api/members/:id`, `/api/org/settings`; POST Better Auth `/api/auth/organization/set-active` only, not update-member-role (`web/app/api/auth/[...all]/route.ts`).
- POST/GET `/api/onboarding`; POST/GET `/api/v1/users`, DELETE `/api/v1/users/:id`; owning specs above.
- `bun scripts/set-member-role.ts <email> <team|user> <orgSlug>` calls changeMemberRole; never creates a member. No disable/re-enable or role-change email (`web/scripts/set-member-role.ts`; `web/lib/members.ts`).
- `bun scripts/check-org-people.ts`: read-only duplicate/membership/assignment/ledger checks, exactly one admin, disabled active access/calls and pending invitations; exits 1 if any count is nonzero. Member/user FKs cover account existence (`web/scripts/check-org-people.ts` `PEOPLE_CHECKS`, `checkOrgPeople`).

## Talks to

- [Auth](auth.md) / Better Auth: identity, active-org preference and cookies; own member actions are closed (`web/lib/auth.ts`; `web/lib/org.ts`).
- [People and emails](invites-and-emails.md): AddedPerson → combined email (`web/lib/invite/org.ts`).
- [Credits](credits.md): fresh learners get starting grants in caller's transaction; studio calls spend org credits (`web/lib/org-people.ts`; `web/lib/minutes.ts`).
- [Twins](twins.md), [Role plays](roleplays.md), [Sessions](sessions.md): owner IDs, assignment removal and call closure (`web/lib/members.ts`).
- PostgreSQL / Chroma / Meteroid: locks, tenant records and founder provisioning (`web/lib/db.ts`; `web/lib/onboarding.ts`; `web/lib/workflow-runs.ts`).

## Edge cases and limits

- Locks cover the people transaction, not subsequent assignment/email writes or call closure. Later failure leaves committed membership/credits/disable intact (`web/lib/org-people.ts`; `web/lib/invite/{twin,roleplay}.ts`; `web/lib/members.ts`).
- Closure selects activating/active, not closing; AggregateError is not an AppError. Another org's simultaneous last-membership disable is not serialized by this org lock (`web/lib/members.ts:47,60–67`).
- Static switch-path segments are manually mirrored; new static pages can truncate like record IDs (`web/lib/org-switch-path.ts`).
- visibleSessions removes disabled/deleted access, but public identity alone remains insufficient and used role-play page loading still has no disabled check before rendering (`web/lib/session-user.ts`; `web/lib/pages/learner.ts:114–147`).
- Logo check trusts the declared MIME type/base64 and byte count, not decoded file signatures. Empty string bypasses it. Metadata parser preserves only a valid JSON object; unreadable metadata is discarded on save (`web/lib/org.ts:159–191`).

## Mismatches

- **People rule 5:** own cross-org member reads still bypass orgPeople: `web/lib/org.ts:53–54`, `web/lib/members.ts:19,47`, `web/app/auth/onboarding/page.tsx:43`. Architecture test allowlists these (`web/tests/lib/org-people-architecture.test.ts:13–21`), contrary to the unconditional service boundary.
- **People rules 5–7, 9, 11–12 / Checks:** scripts remain outside the member-read scan: seed-mock-sessions directly creates learners without grants/email (`web/scripts/seed-mock-sessions.ts:197`); api-contract-check directly reads/inserts (`web/scripts/api-contract-check.ts:93–101`); session-isolation-check reads members and assigns an arbitrary member without learner-role check (`web/scripts/session-isolation-check.ts:13–20,36`). set-member-role no longer bypasses the service.
- **People rule 5:** direct reads also remain in `web/scripts/charge-past-sessions.ts:33`, `simulate-conceptual-understanding.ts:50`, `opening-warm-ab.ts:21`, `chat-completions-bench.ts:210`, `cerebras-30-quality.ts:55`, `model-turn-latency.ts:57`, `simulate-15-turns.ts:106`, `benchmark-30-turns.ts:125`; raw OAuth authorization joins member (`web/lib/notion-oauth.ts:84–94`). Architecture regex misses raw SQL/findFirstOrThrow and excludes scripts (`web/tests/lib/org-people-architecture.test.ts:20–21`).
- **People rule 5:** assignment-derived learner displays still bypass orgPeople: twin cards (`web/lib/twin/trpc.ts:204–230`), copilot role-play get (`web/lib/copilot-studio.ts:151–159`), preview summaries (`web/lib/pages/role-play-preview.ts:14–34`).
- **People rule 8 / no-studio-assignment Check:** the locked add finishes before assignment writes; disable/role change can intervene and a new active/pending assignment can then be written for disabled/studio people. No assignment role/disabled DB constraint closes that race (`web/lib/org-people.ts:139–167`; `web/lib/invite/twin.ts:24–31`; `web/lib/invite/roleplay.ts:29–60`). Grants and member rows themselves are now atomic.
- **People member_disabled — PG/T/R gaps:** enabledMemberships discards disabled rows, so currentMembership yields no_org, org_pin_invalid or another org instead of member_disabled; studio and protected tRPC inherit this. visibleSessions returns null for absent/disabled alike; audio/video give not_found/404 rather than member_disabled/403 or no_org/403. Without selected org they give signed_out even for a logged-in nonmember (`web/lib/org.ts:53–70`; `web/lib/trpc.ts:24–29,70–78`; `web/lib/session-user.ts:46–49`; `web/app/api/sessions/[id]/audio/route.ts:9–19`, `video/route.ts:9–19`).
- **People rules 14, 18 / member_disabled — PG gap:** used role-play links remain rendered for their disabled owner; loadSharedSession reads role/balance but not disabled state. Activation refuses later, which does not satisfy the page-layer check (`web/lib/pages/learner.ts:74–78,114–147`; `web/lib/members.ts:51`; `web/lib/session-activation.ts` `assertNotDisabledIn`).
- **People rule 15 / studio_only — remaining route gaps:** learners still pass getSessionOrg in knowledge list/stats/search and document chunks/preview, and spec-version reads. TTS speech has no sign-in/studio guard; default voice is also public. The refactored loaders/voice library guards do not cover these endpoints (`web/app/api/knowledge/documents/route.ts:7–9`, `stats/route.ts:5–7`, `search/route.ts:5–7`, `[kb]/search/route.ts:7–9`, `documents/[id]/chunks/route.ts:7–9`, `documents/[id]/preview/route.ts:7–9`; `web/app/api/version/[type]/[id]/route.ts:14–17`; `web/app/api/tts/speech/route.ts:7–18`, `default-voice/route.ts:9–19`).
- **People signed_out/studio_only — PG gap:** requireStudioMember turns all AppErrors into null and redirects /auth/no-org, losing signed_out/studio_only distinction. Studio loaders now correctly refuse learners, but server guards do not retain the prescribed refusal (`web/lib/org.ts:127–138`).
- **People invalid_input / not_found — T/R/S gaps:** schema failures have no AppError cause and therefore no data.refusal; legacy page notFound throws bare NOT_FOUND, not the table's message/code. Detail still returns `{error:"Session not found"}`/404 even signed out, and catches all web-access errors (`web/lib/trpc.ts:54–64`; `web/lib/minutes-trpc.ts:138`; `web/lib/pages/router.ts:41–43`; `web/app/api/sessions/[id]/route.ts:35–56`). Shared error comments also say data.code, while actual formatter uses data.refusal (`web/lib/errors.ts:7,54`; `web/lib/trpc.ts:57`).
- **People one_admin / admin_fixed — BA/DB gaps:** DB index prevents two admins but emits a native unique error, not the table's one_admin/409 message. Better Auth actions always give member_action_closed once their hook is reached, without admin_fixed/one_admin conditions; server leave has no refusal hook. See [Auth — Mismatches](auth.md#mismatches) (`web/prisma/migrations/20261114120000_one_admin_per_org/migration.sql:3`; `web/lib/org-people.ts:158–160`; `web/lib/auth.ts:75–82`; dependency `dist/plugins/organization/routes/crud-members.mjs:408–438`).
- **People rule 21 / logo_invalid:** logo="" is persisted without validation; a base64 payload labelled image/png/jpeg/webp is accepted without verifying it is an image. This is weaker than PNG/JPEG/WebP-only content (`web/lib/org.ts:169–175,182–189`).
- **People rule 18 — physical call closure:** disable waits for finalization/workflow startup, not the LiveKit room to close. Startup fallback logs/swallows room-close failure; the already-finalized session is no longer activating/active, so repeat disable cannot retry that room. General repeat-disable/all-calls handling is fixed, but this failure path is not (`web/lib/members.ts:60–67`; `web/lib/session-lifecycle.ts:15–22`; `web/lib/session-end.ts:17–27`).
- **People rule 23:** failures ending calls throw AggregateError and escape the route's errorResponse instead of an app-coded response; disable is already committed (`web/lib/members.ts:64–67`; `web/app/api/members/[id]/route.ts:18–19`; `web/lib/errors.ts:38–40`).
- Historical plans still describe first-call membership, email assignments/invitations and first-sign-in account creation. People supersedes these; common twin links now join on page opening (`plans/people-and-sign-in.md`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/interview-sessions.ts` `activateSession`).
- hideRoleplay copy implies no role-play pages while API/catalog/link gating is partial; disabled UI copy says no sign-in although another enabled org permits it (`web/lib/org.ts:12,27,143–145`; `web/lib/roleplay/trpc.ts`; `web/components/users/team-section.tsx`; `web/lib/members.ts:18–20`).

## Open questions

- Is hideRoleplay a discovery flag or complete feature restriction? `web/lib/org.ts` `requireRoleplayOrg` versus `web/lib/roleplay/trpc.ts` and public catalog.
- Admin handover remains unresolved by [People](people.md#open-questions). Neither Better Auth nor set-member-role now permits it (`web/lib/auth.ts`; `web/lib/members.ts` `changeMemberRole`).
- None about learner studio access or key revocation: People rules 15/22 decide them; both access guards are implemented, with refusal-layer gaps above.

## Tests today

- People DB/invariants: `web/tests/lib/org-people.db.test.ts`, `people-db-rules.db.test.ts`, `people-sql.db.test.ts`; fixture `people-test-db.ts`. Architecture regex scans runtime members with the allowlist above, not raw/nested/script reads.
- Membership/permissions: concurrent `web/tests/lib/org-membership.test.ts` adds invalid-pin refusal; `members.test.ts` adds locked role changes, fixed-admin/self/not-found refusals and repeat-disable closure. `page-router-access.test.ts` covers studio-only loaders and learner own Settings; `people-db-rules.db.test.ts` adds admin index/exactly-one and disabled-access checks. `web/tests/api/route-guards.test.ts` inventories exports/guard classifications, not live authorization. Other coverage: `org-switch-path.test.ts`, `org-flags.test.ts`, `web/tests/api/people-auth.db.test.ts`. Source presence is not a passing result.
- Flow/browser: `web/tests/flows/org-people.flow.test.ts`, `web/e2e/people.spec.ts`; API/credits/onboarding in owning specs.
- Only read-only Refusals title inventory was run here (latest 2 pass/0 fail after concurrent edits; see Auth). No unit/DB/flow/browser behavior suite, live room/email or deployed migration validation. Transaction rollback fault injection, assignment/disable races, real two-tab pin isolation, settings/logo content, server leave and complete refusal-layer checks remain important gaps.
