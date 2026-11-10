# Organizations and roles

> An org is a training workspace. A person has an account, then a membership with a role, then learner assignments. Settings adds members immediately; there is no invitation to accept. `web/lib/org-people.ts` supplies the org's people. Studio selection, permissions and disabling live in `web/lib/org.ts`, `web/lib/auth-roles.ts` and `web/lib/members.ts`. The agreed rules are in [People](people.md); differences are listed below.

## Who uses it

| Actor | What they do | Pointer |
| --- | --- | --- |
| Admin (`admin`) | Runs the studio; cannot change their role or be disabled. | `web/lib/auth.ts` organization hooks; `web/lib/members.ts` `setMemberDisabled` |
| Team (`team`) | Same studio permissions as admin, including adding people and disabling non-admin people other than themself. | `web/lib/auth-roles.ts` `organizationRoles`; PATCH `web/app/api/members/[id]/route.ts` |
| Learner (`user`) | Practises assigned content. Some protected legacy pages/APIs are also available; see limits below. | `web/lib/trpc.ts`; `web/lib/pages/router.ts` |
| API / copilot | Add learners and assign practice for the org. | `web/lib/invite/org.ts` `addLearnerByApi`; `web/lib/copilot-studio.ts` `runCopilotStudio` |
| Operator / founder | Operator creates a founder account/token; signed-in founder creates an org and its admin. | `web/scripts/founder-invite.ts`; POST `web/app/api/onboarding/route.ts` |

## Words used here

| Term | Meaning |
| --- | --- |
| Account | `User`: shared name, email and identity across orgs. |
| Member / person | `Member`: account's role and disabled state in one org; exposed as `OrgPerson`. |
| Studio | Exactly admin/team; `isStudioRole` in `web/lib/org.ts`. |
| Learner | Database role `user`; public API calls it `member` (`web/lib/external-api.ts` `API_LEARNER_ROLE`). |
| Active org / pin | Login session preference / tab's `x-trainertwin-org` header. Neither grants access (`web/lib/org.ts` `pickMembership`; `web/lib/org-pin.ts`). |
| Portal org | Org named by the learner host, independent of studio selection (`web/lib/session-user.ts` `resolveSessionUser`). |
| Assignment | Access to a twin or role play, not membership or a credit balance; see [Twins](twins.md), [Role plays](roleplays.md). |

## Data

| Record | Fields and writers |
| --- | --- |
| `Organization` | Unique slug, name, logo, website, JSON-text metadata, Chroma settings. Onboarding creates; Better Auth and PATCH settings update. `web/prisma/schema.prisma`; `web/app/api/onboarding/route.ts`; `web/app/api/org/settings/route.ts`. |
| `User` | Unique email, name, image, emailVerified. `accountFor` creates a missing account with lower-case email, name before `@`, unverified. Operator creates founders. `web/lib/org-people.ts`; `web/scripts/founder-invite.ts`. |
| `Member` | Required user/org, role (default user), createdAt, nullable disabledAt; unique `(organizationId,userId)`. `addPeopleToOrg` creates; Better Auth updates roles; onboarding creates admin; `setMemberDisabled` updates disabledAt. `web/prisma/schema.prisma`. |
| `Invitation` | Historical table retained, not used for new additions. Migration marks pending rows accepted; old URLs read role/org only to redirect. `web/prisma/migrations/20261111120000_people_first/migration.sql`; `web/app/auth/invite/page.tsx`. |
| Auth `Session` | Active-org preference and login token, distinct from practice session. Better Auth writes; last-enabled-member disable deletes login sessions. `web/lib/auth.ts`; `web/lib/members.ts`. |

Role CHECKs permit only admin/team/user (`20261027010000_org_roles/migration.sql`). The people-first migration merges duplicate members (highest role, oldest row), backfills accounts/members from assignment emails and pending invitations, requires assignment owners, removes email columns and deletes studio-held learner assignments. Twin ownership has a composite FK `(orgId,userId)` to member; role plays require memberId. There is no unique admin index (`web/prisma/migrations/20261111120000_people_first/migration.sql`; `web/prisma/schema.prisma`).

Membership: absent → enabled → disabled → enabled. Role: user/team may change through Better Auth; admin stays admin. Moving to studio deletes both assignment kinds, leaving session history with assignment references cleared (`web/lib/auth.ts` `afterUpdateMemberRole`; `web/lib/members.ts` `dropLearnerAssignments`).

## How it works

### Add and list people

1. `orgPeople(orgId, filter, tx?)` returns oldest first (createdAt, then ID), excluding disabled by default. Filters: roles, emails (case-insensitive), userIds, memberIds. `orgPerson` returns one by account/member/email, including disabled. `studioPeopleEmails` includes disabled admin/team. All three live in `web/lib/org-people.ts`.
2. `addPeopleToOrg` trims/lowercases/deduplicates emails and drops empty values. Invalid emails fail 400; disabled recipients fail 409 with re-enable guidance; adding learners refuses existing studio recipients with 409. Existing members keep their role. Fresh admin addition fails 403 when more than one is requested or an admin already exists (`web/lib/org-people.ts`).
3. Learner starting grants commit first; credit shortage stops the whole batch before any account/member write. Then each missing account is created and its member inserted. Unique conflicts recover the existing account/member. This is not one transaction covering grants and all people (`addPeopleToOrg`, `accountFor`; see Mismatches and [Credits](credits.md)).
4. Settings calls studio-only `minutes.addPeople` (role team/user, 1–50 emails, optional whole minutes 1–360), then `runAddOrgPeople`. Its `add-org-people` workflow adds people, then queues one combined email per new member. Existing members count as `already`, with no added email (`web/lib/minutes-trpc.ts`; `web/lib/workflow-runs.ts`; `web/workflows/add-org-people.ts`; `web/lib/invite/org.ts` `addOrgPeople`).
5. Settings uses `orgPeople(...includeDisabled:true)` only, with Team and Users groups and matching counts. There are no pending or awaiting rows. Activity lists/pickers also start from this service; filters differ intentionally: Users includes disabled learners; pickers only enabled learners; API lists enabled learners. Role-play Users additionally includes current studio members with historical practice (`web/lib/pages/router.ts` `settings`; `web/components/users/team-section.tsx`; `web/lib/learners.ts`; `web/lib/roleplay/trpc.ts` `users.list`).

### Work in and switch orgs

`currentMembership` reads the account's enabled memberships on every request even with a cached login. `pickMembership` prefers pinned studio → active studio → oldest studio → active other membership → oldest other membership. An invalid/disabled/learner pin is ignored. `getTrainerOrg` requires studio role; `getSessionOrg` accepts any selected role (`web/lib/org.ts`).

The dash switcher lists enabled studio orgs. `OrgPin` wraps same-origin fetch, preserving explicit pins and not pinning cross-origin requests. Switching calls Better Auth setActive, then reloads with `pathAfterOrgSwitch`: section/list URLs keep query; record URLs truncate to the list. Another tab retains its fetch pin; full document requests use active org (`web/components/org-switcher.tsx`; `web/components/org-pin.tsx`; `web/lib/org-switch-path.ts`).

Portal loaders choose org from host, not pin. Resolving identity alone does not prove membership. Org home no longer accepts invitations; role-play members already exist. Opening an active common twin-code page adds the signed-in existing account through addPeopleToOrg, gives starting credits once and creates/reuses its assignment. Activation passes join=false and never creates a member; a nonmember direct start is refused (`web/lib/session-user.ts`; `web/lib/pages/org-home.ts`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/twin-access.ts` `twinAccessByCode`; `web/lib/interview-sessions.ts` `activateSession`).

### Disable, re-enable and change role

PATCH `/api/members/:id` requires studio, strict `{disabled:boolean}`, and same-org member. Bad input is 400, no studio is 403, missing/foreign member is 404 (`web/app/api/members/[id]/route.ts`).

`setMemberDisabled` refuses admin/self disable (400), skips repeat disable, then transactionally timestamps membership, revokes active twins by userId, cancels pending role plays by memberId, revokes assigned practice sessions and clears their runtime token. It deletes login sessions only without another enabled membership. After commit it closes activating/active calls as abandoned. Past sessions, used role plays, credits and other orgs remain. Re-enable only clears disabledAt; revoked assignments need reassignment (`web/lib/members.ts`).

Better Auth forbids member removal and changing an existing admin's role. Promotion checks for another admin first; after role update, non-user roles call `dropLearnerAssignments`. That deletes assignments, not sessions or credits (`web/lib/auth.ts` organization hooks; `web/lib/members.ts`).

### Onboarding and branding

Founder onboarding creates org/admin transactionally, then runs Chroma/Meteroid/trial provisioning; failed setup attempts compensating cleanup and restores the token. See [Auth](auth.md), [Credits](credits.md) (`web/app/api/onboarding/route.ts`; `web/lib/workflow-runs.ts` `runOnboarding`).

Settings account name is shared and email read-only. Branding saves name/logo through Better Auth, then website/accent through a separate PATCH; partial save is possible. PATCH requires studio, strict HTTPS-or-empty website ≤2048 and #RGB/#RRGGBB accent; bad input is 422. Metadata keys survive valid parsing. Logo is an inline PNG/JPEG/WebP data URL, client-limited to 1,000,000 bytes; slug is read-only (`web/components/profile-form.tsx`; `web/app/api/org/settings/route.ts`; `web/lib/org.ts` `parseAccentColor`).

## Rules

1. An org/account pair has at most one member; new assignments require that member. No access by assignment email remains (`web/prisma/schema.prisma`; people-first migration; `web/lib/assignments.ts` `assignmentMatchesUser`; `web/lib/twin-access.ts` `usable`).
2. Normal adding preserves an existing role and refuses disabled members and studio learner recipients before grants/writes (`web/lib/org-people.ts` `addPeopleToOrg`).
3. Admin/team have equal configured studio permissions, no org-delete permission; learners have Better Auth member permissions and no key-management permission (`web/lib/auth-roles.ts`).
4. `protectedProcedure` requires enabled membership; `studioProcedure` also refuses learners. Public portal procedures separately check access. Dash layout only checks login; twin layouts require studio; roleplay/persona layouts also apply hideRoleplay (`web/lib/trpc.ts`; `web/lib/pages/router.ts`; `web/app/dash/layout.tsx`; `web/lib/org.ts` `requireStudioMember`, `requireRoleplayOrg`).
5. Only JSON boolean hideRoleplay=true hides menus/roleplay layouts and home assignments; it does not revoke links or gate all APIs/legacy agents (`web/lib/org.ts`; `web/lib/pages/org-home.ts`; `web/lib/roleplay/trpc.ts`).
6. Disable preserves identity/history and cannot target admin/self. New login is refused only when all memberships are disabled (`web/lib/members.ts`; `web/lib/auth.ts` session-create hook).
7. Studio promotion removes learner assignments through the Better Auth hook, not just from display (`web/lib/auth.ts` `afterUpdateMemberRole`; `web/lib/members.ts` `dropLearnerAssignments`).
8. API org comes from key, never pin/host; API role spelling is member. See [Public API](public-api.md) (`web/lib/external-api.ts`).

## Entry points

- Settings, Users and pickers: `web/app/dash/settings/page.tsx`, `web/components/users/{team-section,invite-user}.tsx`, `web/lib/pages/router.ts`, `web/lib/learners.ts`.
- Studio tRPC: `minutes.addPeople/add/addMany/org/version/learner`, `twin.*`, `roleplay.*`; transports `web/app/api/trpc/[trpc]/route.ts`, `web/app/api/twin/[[...route]]/route.ts`, `web/app/api/roleplay/[[...route]]/route.ts`.
- PATCH `/api/members/:id`, PATCH `/api/org/settings`; Better Auth update-member-role/set-active through `web/app/api/auth/[...all]/route.ts`.
- POST/GET `/api/onboarding`; POST/GET `/api/v1/users`, DELETE `/api/v1/users/:id`; see owning specs.
- `bun scripts/check-org-people.ts`: read-only counts for duplicate members, assignment tenant membership, studio-held assignments, orphan learner ledger rows and pending invitations; exits 1 on any failure (`web/scripts/check-org-people.ts`). User/member FKs enforce account existence.
- `web/scripts/set-member-role.ts` still exists; it bypasses the normal service/hooks (Mismatches). No disable/re-enable email is sent by `setMemberDisabled`.

## Talks to

- [Auth](auth.md) / Better Auth: identity, active-org preference, role updates and shared cookies; `web/lib/auth.ts`, `web/lib/org.ts`.
- [Invites and emails](invites-and-emails.md): newly added people receive a combined email; `web/lib/invite/org.ts`.
- [Credits](credits.md): learners get starting grants; studio calls use billed org balance; `web/lib/org-people.ts`, `web/lib/minutes-trpc.ts`.
- [Twins](twins.md), [Role plays](roleplays.md), [Sessions](sessions.md): account/member ownership and assignment removal/closure; `web/lib/members.ts`.
- PostgreSQL and Chroma/Meteroid: tenant records and onboarding provisioning; `web/prisma/schema.prisma`, `web/lib/workflow-runs.ts`.

## Edge cases and limits

- Add/grant checks are not a lock on role or disabled changes. A conflicting member insert is treated as added=true, even if another request created it. Assignment/email failures after membership or credit writes do not undo earlier writes (`web/lib/org-people.ts` `addPeopleToOrg`).
- Room closure occurs after disable commits. Failure leaves disable committed; repeat disable returns before retrying closure; closing-status calls are not selected (`web/lib/members.ts`).
- Pins fall back to another enabled org rather than fail. Static switch-path segments are mirrored manually; new static pages may truncate like record IDs (`web/lib/org.ts`; `web/lib/org-switch-path.ts`).
- Public identity is not an enabled-membership read guard. `isStudioMember` and uploader refuse disabled membership, but recording/session-detail studio role checks omit disabledAt and retained used role-play links can render before activation refuses (`web/lib/pages/learner.ts`; `web/lib/upload-access.ts`; `web/app/api/sessions/[id]/{route.ts,audio/route.ts,video/route.ts}`).
- Learners can access protected overview/talk/voices/settings/developer/twinKnowledge loaders and some legacy knowledge/voice mutations, despite no studio assignment permissions (`web/lib/pages/router.ts`; `web/app/api/knowledge/[[...kb]]/route.ts`; `web/app/api/tts/voices/route.ts`).

## Mismatches

- **People rule 5:** direct membership reads remain outside the service: `web/lib/org.ts:66` (enabledMemberships), `web/lib/members.ts:30,58` (disabled/elsewhere checks), `web/app/auth/onboarding/page.tsx:43` (admin memberships). These are account-own cross-org reads, explicitly allowlisted by `web/tests/lib/org-people-architecture.test.ts:13`, rather than the rule's unconditional one-service boundary.
- **People rules 1, 5–7, 9, 11–12 and assignment check:** `web/scripts/set-member-role.ts:22,31,42,44` reads/creates members directly, requires an existing account, skips starting credits/email, creates a new admin without the second-admin check, can demote the existing admin and promotes without dropping assignments. `web/scripts/seed-mock-sessions.ts:197` also directly adds learners without grants/email. These scripts are outside the architecture test's member-read scan.
- **People rule 5:** direct org-person reads remain in scripts: `web/scripts/api-contract-check.ts:93,95`, `web/scripts/session-isolation-check.ts:13,36`, `web/scripts/charge-past-sessions.ts:33`, `web/scripts/simulate-conceptual-understanding.ts:50`. The contract-check script also directly inserts a learner at `:101` (rules 6, 9, 11–12); isolation check directly assigns its first arbitrary member at `:20`, without a learner-role check (rule 7).
- **People rule 7:** admin checks precede writes without serialization (`web/lib/org-people.ts:137–153`; `web/lib/members.ts:19–20`; `web/lib/auth.ts:69–74`). Concurrent additions/promotions can create two admins. The migration's INSERT also checks pre-statement admins, so multiple pending admin invitations in an admin-less org can backfill multiple admins (`web/prisma/migrations/20261111120000_people_first/migration.sql:38–46`).
- **People rule 8 / no-studio-assignment check:** disabled/studio validation precedes independent credit/member/assignment writes. Concurrent disable/promotion can pass the old check and then receive a new assignment (`web/lib/org-people.ts:128–153`; `web/lib/invite/twin.ts:24–32`; `web/lib/invite/roleplay.ts:29–60`). No assignment-role/disabled DB constraint closes this race.
- **People learner-ledger check:** grants commit before accounts/members (`web/lib/org-people.ts:143–153`; `web/lib/minutes.ts:176–178`). Later failure can leave a grant without a member and part of a batch added; shortage itself does correctly add nobody.
- Historical plans still describe first-call membership, email assignments and invitations. Those are superseded by [People](people.md); common twin links now join on page opening, not call start (`plans/people-and-sign-in.md`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/interview-sessions.ts` `activateSession`).
- Existing broader UI/plan mismatches remain: users-only-practise versus legacy protected loaders; hideRoleplay copy versus partial gating; disable copy versus multi-org login; slug's 3–30 copy versus one-character server regex (`web/lib/pages/router.ts`; `web/lib/org.ts`; `web/components/users/team-section.tsx`; `web/lib/slugs.ts`).

- **People rule 5:** raw authorization lookup in `web/lib/notion-oauth.ts:84–94` joins member directly instead of orgPerson. Benchmark/simulation scripts also read org members directly: `web/scripts/opening-warm-ab.ts:21`, `chat-completions-bench.ts:210`, `cerebras-30-quality.ts:55`, `model-turn-latency.ts:57`, `simulate-15-turns.ts:106`, `benchmark-30-turns.ts:125`. The architecture regex misses raw SQL and findFirstOrThrow, and its member-read roots exclude scripts (`web/tests/lib/org-people-architecture.test.ts`).
- **People rule 5:** some assignment-learner displays still obtain identity from nested assignment user/member reads rather than orgPeople: twin library cards (`web/lib/twin/trpc.ts:205–231`), copilot role-play get (`web/lib/copilot-studio.ts:151–162`), legacy preview assignment summaries (`web/lib/pages/role-play-preview.ts:14–34`). Preview uses orgPeople for its picker, but not these summaries; the member-only architecture regex does not catch assignment-derived lists.

## Open questions

- Should learners' legacy overview/knowledge/voice access be removed? `plans/twin-roleplay-db-split.md` §13 versus `web/lib/pages/router.ts` and legacy knowledge/TTS routes.
- Is hideRoleplay a discovery flag or a complete feature restriction? `web/lib/org.ts` `requireRoleplayOrg` versus `web/lib/roleplay/trpc.ts` and public catalog.
- Should used role-play links and creator API keys be revoked on disable? `web/lib/members.ts` preserves both; `web/lib/external-api.ts` does not globally re-check creator membership.
- How is admin transfer/recovery performed? Better Auth cannot change an admin; `web/scripts/set-member-role.ts` bypasses this (`web/lib/auth.ts`).

## Tests today

- People DB/invariants: `web/tests/lib/org-people.db.test.ts`, `people-db-rules.db.test.ts`, `people-sql.db.test.ts`; fixture `people-test-db.ts`. Architecture test scans runtime member reads with the allowlist above, and runtime/scripts for removed email columns.
- Membership selection/permissions: `web/tests/lib/org-membership.test.ts`, `members.test.ts`, `org-switch-path.test.ts`, `org-flags.test.ts`; auth role/promotion/invitation refusals in `web/tests/api/people-auth.db.test.ts`.
- Flow/browser: `web/tests/flows/org-people.flow.test.ts`, `web/e2e/people.spec.ts`; API/credits and onboarding suites in their owning specs.
- Not run for this spec edit. Gaps: role/disable/admin races, post-grant member-write failure, real two-tab pin isolation and live closure/email delivery. Rule mismatches above remain code issues, not new product questions.
