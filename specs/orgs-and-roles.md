# Organizations and roles

> An organization (org) is a training workspace with its own members, training content, sessions and branding. A person's role belongs to their membership in each org, not to their account. Admin and team members manage the studio; users practise. This spec describes the actual guards, including places where learners can access more than that summary suggests. Sources: `web/lib/org.ts`, `web/lib/auth-roles.ts`, `web/lib/members.ts`, `web/lib/pages/router.ts`.

## Who uses it

| Actor | What they do here | Source |
| --- | --- | --- |
| Org admin (`admin`) | Runs the studio. Their role is fixed; they cannot be disabled. | `web/lib/auth.ts` organization hooks; `web/lib/members.ts` `setMemberDisabled` |
| Team member (`team`) | Has the same studio and organization-management permissions as admin. Can disable another non-admin member, including another team member. | `web/lib/auth-roles.ts` `organizationRoles`; `web/app/api/members/[id]/route.ts` PATCH |
| Learner (`user`) | Practises; can also call the member-level loaders and endpoints listed below. Cannot manage members, credits or API keys through the studio guards. | `web/lib/trpc.ts`; `web/lib/pages/router.ts` |
| Founder with an invite | Creates an org and becomes its admin, even if already a member of another org. | `web/app/api/onboarding/route.ts` POST |
| API integrator | Uses an org-scoped key, not a signed-in member role. Can disable learners with `users:write`. | `web/lib/external-api.ts` `requireExternalApi`; `web/app/api/v1/users/[id]/route.ts` DELETE |
| TrainerTwin operators | Can provision founder invites or update database-only metadata. There is no fourth staff role in `member.role`. | `web/prisma/schema.prisma` `FounderInvite`, `Member`; `web/lib/org.ts` `parseHideRoleplay` |

## Words used here

| Term | Meaning / code name |
| --- | --- |
| Organization / workspace / org | `Organization`, stored in `organization`. Tenant for training data. |
| Account | `User`, stored in `user`. One identity can have memberships in several orgs. |
| Membership / member | `Member`, stored in `member`: an account's role and enabled state in one org. Not the same as an invitation or assignment. |
| Studio role | Exactly `admin` or `team`; tested by `isStudioRole`. |
| Learner role | Exactly `user` (`LEARNER_ROLE`). The external API calls it `member` (`API_LEARNER_ROLE`); that is not a valid database role. |
| Active org | `Session.activeOrganizationId`, set by Better Auth. A preference, not proof of access. |
| Pinned org | `x-trainertwin-org` (`ORG_PIN_HEADER`): the org a studio tab loaded in. It overrides the active org only for an enabled studio membership. |
| Portal org | Org identified by the learner site's subdomain slug; independent of the studio pin and active org. |
| Disabled member | Membership with non-null `disabledAt`. The account and its history remain. |
| Assignment | Permission to practise a particular twin or role play. Not itself a studio role. See [Twins](twins.md) and [Role plays](roleplays.md). |
| Org metadata | Nullable JSON text in `Organization.metadata`, currently read for `accentColor` and `hideRoleplay`. |

Definitions: `web/prisma/schema.prisma` `User`, `Member`, `Organization`, `Session`; `web/lib/org.ts`; `web/lib/org-pin.ts`; `web/lib/session-user.ts`; `web/lib/external-api.ts`.

## Data

| Record | Key fields and writers | Source |
| --- | --- | --- |
| `Organization` → `organization` | `id`; required `name`; globally unique `slug`; nullable `logo`, `websiteUrl`, `metadata`; `createdAt`. Founder onboarding creates it; Better Auth updates name/logo; PATCH settings updates website/accent. `chromaTenantId` and `chromaDatabase` (default `default`) are knowledge-storage configuration, not roles. | `web/prisma/schema.prisma` `Organization`; `web/app/api/onboarding/route.ts`; `web/components/profile-form.tsx`; `web/app/api/org/settings/route.ts`; `web/lib/chroma-tenant.ts` |
| `Member` → `member` | `id`, `organizationId`, `userId`, `role` (default `user`), `createdAt`, nullable `disabledAt`. Better Auth creates/updates roles; onboarding creates admin; first assigned practice creates a missing learner membership; `setMemberDisabled` writes disabled state. | `web/prisma/schema.prisma` `Member`; `web/lib/auth.ts`; `web/lib/interview-sessions.ts` `ensureLearnerMember`; `web/lib/members.ts` |
| `Invitation` → `invitation` | Org, email, role (default `user`), status, expiry and inviter. Role is copied on acceptance. This module owns its role restrictions; delivery and acceptance lifecycle belong to [Invites and emails](invites-and-emails.md). | `web/prisma/schema.prisma` `Invitation`; `web/lib/auth.ts` organization plugin; `web/lib/invite/accept.ts` |
| `Session` → `session` | Auth session with `userId`, token/expiry and nullable `activeOrganizationId`. Better Auth sets active org. Disabling a last-enabled membership deletes these auth sessions, not practice-session history. | `web/prisma/schema.prisma` `Session`; `web/components/org-switcher.tsx`; `web/lib/members.ts` |

Database CHECK constraints permit only one exact lower-case role string, `admin`, `team` or `user`, on both members and invitations. `owner`, `member`, `Admin` and comma-separated roles are invalid. The migration converts old owner/admin spellings to `admin`, existing team to `team`, everything else to `user`. There is no one-admin unique index or unique `(organizationId, userId)` constraint in the current schema. Sources: `web/prisma/migrations/20261027010000_org_roles/migration.sql`; `web/prisma/schema.prisma` `Member`.

Lifecycles:

- Membership: enabled (`disabledAt = null`) → disabled (timestamp) → enabled. Disabling never deletes the member. Sources: `web/prisma/migrations/20261028000000_member_disabled/migration.sql`; `web/lib/members.ts` `setMemberDisabled`.
- Role: founder starts as `admin`; existing admin cannot change role. Non-admin roles can change through Better Auth, subject to permissions and the second-admin check. Settings displays roles but does not edit them. Sources: `web/lib/auth.ts` hooks; `web/components/users/team-section.tsx`.
- Org: founder invite → organization plus admin → active org. No normal org-delete permission is granted. Onboarding may delete its newly created org to clean up a failed setup. Sources: `web/app/api/onboarding/route.ts`; `web/lib/auth-roles.ts`.

## How it works

### Resolve the working org on every studio request

1. `currentMembership(headers)` gets the Better Auth session. No session returns `null`. A session without membership returns `{ session, member: null }`. Source: `web/lib/org.ts` `currentMembership`.
2. Query that user's memberships with `disabledAt: null`, oldest `createdAt` first. This database query happens even with the five-minute cached auth cookie. Sources: `web/lib/org.ts` `enabledMemberships`; `web/lib/auth.ts` session configuration.
3. `pickMembership` chooses, in this exact order: studio membership matching pin → studio membership matching active org → oldest studio membership → any membership matching active org → oldest membership → null. A pin to a learner org, disabled org or stranger's org is ignored, not an error. Source: `web/lib/org.ts` `pickMembership`.
4. `getSessionOrg` exposes that org for any role. `getTrainerOrg` returns it only for admin/team, adding the actor and role. tRPC uses the same resolver to populate `ctx.user` (`id`, name, email, `orgId`, `orgSlug`, role). Sources: `web/lib/org.ts`; `web/lib/trpc.ts` `userFrom`.
5. `protectedProcedure` refuses no-session callers with `UNAUTHORIZED`, and signed-in callers without an enabled membership with `FORBIDDEN`. `studioProcedure` also refuses role `user` with `FORBIDDEN`. Client `useApi` sends these gates to `/auth/sign-in` and `/auth/no-org`, respectively. Sources: `web/lib/trpc.ts`; `web/lib/api.ts`.

`resolveHome` uses this same selection: any studio membership lands on dash; learner-only accounts land on their selected org's portal; no enabled membership lands on `/auth/no-org`. Signing in/host routing itself belongs to [Auth](auth.md). Source: `web/lib/auth-home.ts` `resolveHome`.

### Switch orgs without changing another tab's saves

1. The dash layout loads the current org and `studioOrgsOf(userId)` (enabled admin/team memberships only, oldest first). The sidebar shows the switcher only for two or more such orgs. Sources: `web/app/dash/layout.tsx`; `web/lib/org.ts` `studioOrgsOf`; `web/components/org-switcher.tsx`.
2. `OrgPin` is rendered before page children. It wraps `window.fetch` once and adds the pin to all same-origin requests, including REST, tRPC and client-side server navigation. It preserves an explicitly supplied pin and does not add it cross-origin. This is tab memory, not local storage. Source: `web/components/org-pin.tsx` `install`, `OrgPin`.
3. Selecting the current org or selecting while busy does nothing. Otherwise Better Auth `organization.setActive` updates the session. Failure shows a toast and leaves the page in place. Success uses `window.location.assign`, discarding the old tab's React Query cache. Source: `web/components/org-switcher.tsx` `switchOrg`.
4. `pathAfterOrgSwitch` keeps section/list URLs and their query. At the first non-static segment after the section it truncates to the list and drops the query: `/users/abc` → `/users`; `/twin/sessions/x?turn=2` → `/twin/sessions`. Source: `web/lib/org-switch-path.ts`.
5. Full document loads do not use the fetch wrapper, so they use the session's active org. An already-open tab retains its pin for subsequent fetches even after another tab switches. If that membership is disabled, the next request falls back through the selection order above. Sources: `web/components/org-pin.tsx`; `web/lib/org.ts` `pickMembership`.

### Learner requests use the portal org, not the studio selection

`resolveSessionUser` resolves `portalSlug(host)` through `getOrgBySlug`. A found portal org wins, with or without sign-in or membership. Only when no portal org is found does it fall back to `currentMembership`. The returned user is the signed-in identity; this function is not a membership or disabled-state guard. Sources: `web/lib/session-user.ts`; `web/lib/org.ts` `getOrgBySlug`.

`page.orgHome`, `page.twinLink` and `page.sharedSession` are public procedures. Their loaders resolve the host again and decide whether to show public profile, sign-in, switch-account, unavailable, out-of-minutes or practice content. Org home may accept a pending learner invitation; a first assigned session start creates a missing `user` membership. Before any session activation, `activateSession` calls `assertNotDisabledIn(userId, orgId)`. Membership is not required merely to view a public trainer profile. Sources: `web/lib/pages/router.ts`; `web/lib/pages/org-home.ts` `loadOrgHome`; `web/lib/pages/learner.ts`; `web/lib/invite/accept.ts`; `web/lib/interview-sessions.ts` `activateSession`, `ensureLearnerMember`. See [Learner portal](learner-portal.md) and [Sessions](sessions.md) for content and activation rules.

### Disable and re-enable a member

`PATCH /api/members/:id` accepts only `{ disabled: boolean }` and requires `getTrainerOrg` (403 otherwise). Bad body is 400. Member lookup includes the actor's org, so a missing or other-org member is 404. Source: `web/app/api/members/[id]/route.ts`.

For disable, `setMemberDisabled` does the following (`web/lib/members.ts`):

1. Refuse an admin (400, `The admin cannot be disabled`) or the actor themself (400, `You cannot disable yourself`). Already disabled returns without repeating side effects.
2. Count other enabled memberships for that account across all orgs.
3. In one database transaction: timestamp `disabledAt`; delete all of the user's auth sessions only if no other enabled membership exists; revoke active twin assignments matching user ID or lower-cased email in this org; cancel **pending** role-play assignments matching member ID or email; revoke `assigned` practice sessions for this user/org and clear their runtime token hashes.
4. After that transaction, find `activating`/`active` sessions for the user in this org and call `closeInterviewSession(id, "abandoned")` for each. Call closure/recording preservation is delegated to [Sessions](sessions.md).

Past sessions/reports, used role-play assignments, membership, credits and other-org assignments are not deleted or reset by this function. Pending Better Auth org invitations and twin share-link records are not cancelled by it either. Re-enable only clears `disabledAt`; it does not restore revoked assignments or cancelled practice invitations. The re-enable branch occurs before the admin/self disable restrictions. Source: `web/lib/members.ts` `setMemberDisabled`.

The auth session-create hook refuses sign-in only if the user has at least one membership and **all** memberships are disabled. A person with another enabled org can still sign in. Studio resolvers exclude disabled memberships on every request; session activation rejects a disabled membership in the target org with 403 and `Your access has been disabled. Contact your trainer.` Sources: `web/lib/auth.ts` `databaseHooks`; `web/lib/members.ts` `isDisabledUser`, `assertNotDisabledIn`; `web/lib/org.ts` `enabledMemberships`.

### Settings and branding

- `page.settings` returns account identity and organization fields (including raw metadata) for any enabled member. For admin/team only, it also returns all members including disabled ones, pending unexpired org invitations, and unjoined twin/role-play assignees grouped by email. Learners receive `team: null`; `?tab=team` falls back to Account. Sources: `web/lib/pages/router.ts` `settings`; `web/app/dash/settings/page.tsx`; `web/lib/invite/awaiting.ts`.
- Account edits use Better Auth `updateUser({ name })`; the form trims/requires a name and shows email read-only. This edits the shared account, not a per-org name. Source: `web/components/profile-form.tsx` `ProfileForm`.
- Branding shows editable name, logo, website and accent, with slug read-only. The tab/form is shown to learners too, but saving org changes requires studio permissions at the server. Source: `web/app/dash/settings/page.tsx`; `web/components/profile-form.tsx` `OrganizationForm`; `web/lib/auth-roles.ts`; `web/app/api/org/settings/route.ts`.
- Saving first calls Better Auth organization update with explicit org ID for name/logo, then PATCHes current-org website/accent. These are **two writes**, not one transaction. First-write success followed by PATCH failure leaves the new name/logo saved and shows an error; full success reloads the document. Source: `web/components/profile-form.tsx` `saveOrganization`.
- Logo selection accepts PNG/JPEG/WebP, rejects sizes **over** 1,000,000 bytes, and uses FileReader to store a data URL in `logo`. These checks are client-side. Learner session branding renders only data URLs prefixed as PNG/JPEG/WebP. Sources: `web/components/profile-form.tsx` `uploadLogo`; `web/lib/pages/learner.ts` `dataImage`.
- PATCH settings requires both a `#RGB` or `#RRGGBB` accent and a trimmed website string of at most 2048 characters (empty or an absolute HTTPS URL), with no extra fields. Bad JSON/schema returns 422, even for a bad accent, with `Enter a valid HTTPS website URL`. No session is 401; no enabled membership or learner role is 403. Nonempty website is normalized with `new URL(...).toString()`; empty becomes null. Existing parsed metadata keys are preserved while replacing `accentColor`; malformed JSON is replaced by a fresh object. Source: `web/app/api/org/settings/route.ts` PATCH.
- `parseAccentColor` accepts any string when reading metadata, without hex validation; absent, wrong-type or unparseable values yield null. `OrgAccentProvider` overrides `--brand` and `--brand-strong` in both layouts. The form defaults/resets to `#EC3013`. Sources: `web/lib/org.ts`; `web/components/org-accent-provider.tsx`; `web/components/profile-form.tsx`; `web/app/dash/layout.tsx`; `web/app/(org)/layout.tsx`.

## Rules

1. Roles are per org. Admin/team are equally privileged; neither can delete an org through the configured access-control statements. Learner receives Better Auth `memberAc` plus no API-key actions. Source: `web/lib/auth-roles.ts` `organizationRoles` (imports Better Auth `adminAc`/`memberAc`).
2. Founder onboarding creates the first admin directly. Generic self-serve org creation is disabled; `organizationLimit: 1` in the plugin is not a one-membership restriction. Existing members can onboard another org and it becomes active. Sources: `web/lib/auth.ts` organization configuration; `web/app/api/onboarding/route.ts` POST.
3. Inviting, adding or promoting to admin is forbidden if the org already has a member whose role is exactly `admin`. Changing an existing admin's role is always forbidden, even a request to set it to admin again. Errors are Better Auth `FORBIDDEN` with `An organization has exactly one admin. Invite or set people as team or user.` Sources: `web/lib/members.ts` `assertNoSecondAdmin`; `web/lib/auth.ts` organization hooks. This is an application check, not a database exactly-one guarantee; see limits below.
4. Every Better Auth member-removal request is forbidden with `Members are not removed. Disable them instead.` This also prevents leaving through that removal path. Source: `web/lib/auth.ts` `beforeRemoveMember`; `web/lib/members.ts` `NO_REMOVAL_MESSAGE`.
5. Disable is org-scoped and cannot target the admin or actor. Repeated disable is a no-op; enable only clears `disabledAt`. New sign-in is refused only when every membership is disabled. Sources: `web/lib/members.ts`; `web/app/api/members/[id]/route.ts`.
6. A supplied active-org ID or pin never grants membership. Studio requests select only enabled memberships, with studio roles preferred even over an active learner org. Source: `web/lib/org.ts` `enabledMemberships`, `pickMembership`.
7. Page visibility, loader access and mutation access are distinct. The dash layout checks sign-in only; nested layouts and the tRPC matrix below are the actual role guards. `requireStudioMember` redirects non-studio callers to `/auth/no-org`; `requireRoleplayOrg` additionally redirects hidden-roleplay orgs to `/twin`. Sources: `web/app/dash/layout.tsx`; `web/app/dash/twin/layout.tsx`; `web/app/dash/roleplay/layout.tsx`; `web/app/dash/personas/layout.tsx`; `web/lib/org.ts`.
8. Only the literal JSON boolean `hideRoleplay: true` enables twin-only presentation. It hides the sidebar Role play group, redirects `/roleplay/**` and `/personas/**`, and omits assigned role plays from org home. It does **not** disable the roleplay tRPC router, legacy `/agents` pages, direct practice links or public role-play catalog. Sources: `web/lib/org.ts` `parseHideRoleplay`, `requireRoleplayOrg`; `web/components/app-sidebar.tsx`; `web/lib/pages/org-home.ts`; `web/lib/roleplay/trpc.ts`; `web/lib/pages/router.ts`; `web/lib/pages/learner.ts`; `web/app/api/portal/agents/route.ts`.
9. Org API keys are managed only by studio members. External REST calls resolve org from the verified key's `referenceId`, not session active org, host or pin. Source: `web/app/api/developer/api-keys/route.ts`; `web/lib/external-api.ts` `requireExternalApi`.
10. A learner can start assigned practice; direct agent-slug starts without a deployment key are studio-only. Session activation always checks disabled state. Admin/team practise without learner credits. Sources: `web/app/api/sessions/route.ts` POST; `web/lib/interview-sessions.ts` `activateSession`; `web/lib/pages/learner.ts` `twinAccessFor`; see [Credits](credits.md) for metering.

### Studio page permissions matrix

Here and below **Yes** means passes the role guard, not guaranteed record existence or successful validation. Roles refer to the **selected** org. All dash pages require a valid sign-in via `web/app/dash/layout.tsx`; the sidebar is not role-filtered (`web/components/app-sidebar.tsx`). URLs below are the visible dash-host paths; source pages live under `web/app/dash/`.

| Pages | admin | team | user | Actual guard / source |
| --- | --- | --- | --- | --- |
| `/twin` and every descendant: detail, edit, assign, calibration/calibrate, sessions, users, brain/knowledge/voice/avatar, settings | Yes | Yes | No | `web/app/dash/twin/layout.tsx` `requireStudioMember`; `web/lib/twin/trpc.ts` |
| `/roleplay` and every descendant; `/personas` and every descendant | Yes, unless hidden | Yes, unless hidden | No | `web/app/dash/roleplay/layout.tsx`, `web/app/dash/personas/layout.tsx` `requireRoleplayOrg` |
| `/agents`, `/agents/:slug`, `/agents/:slug/edit`, `/agents/:slug/calibrate`, demo `/agents/:slug/calibrations/:id`, `/agents/fidelity` | Yes | Yes | No data access | `web/lib/pages/router.ts` `agents`, `rolePlayPreview`, `agentSpec`, `calibrationAgent`, `fidelity`; `web/app/dash/agents/**/page.tsx` |
| `/sessions`, `/sessions/:id`, `/users`, `/users/:id` | Yes | Yes | No data access | `web/app/dash/sessions/**/page.tsx`, `web/app/dash/users/**/page.tsx`; `page.sessions`, `page.session`, `page.users`, `twin.users.get` |
| `/credits` | Yes | Yes | No data access | `web/app/dash/credits/page.tsx`; `web/lib/minutes-trpc.ts` `org` |
| `/overview` | Yes | Yes | Yes, org counts and recent sessions, not only their own | `web/app/dash/overview/page.tsx`; `web/lib/pages/router.ts` `overview` |
| `/talk` | Yes | Yes | Yes, runnable role plays plus only assigned twins in loader | `web/app/dash/talk/page.tsx`; `web/lib/pages/router.ts` `talk`; activation is checked separately |
| `/voice`, `/voice/cloning`, `/voice/:voiceId` | Yes | Yes | Yes | `web/app/dash/voice/**/page.tsx`; `page.voices`; `web/app/api/tts/voices/route.ts` |
| `/developer` | Yes, key manager | Yes, key manager | Yes, no keys or manager | `web/app/dash/developer/page.tsx`; `page.developer` |
| `/settings` | Account, Team, Branding | Account, Team, Branding | Account and Branding; cannot save org changes | `web/app/dash/settings/page.tsx`; `page.settings`; branding guards above |
| `/knowledge/:slug` | Yes | Yes | Yes (legacy knowledge APIs) | `web/app/dash/knowledge/[slug]/page.tsx`; `web/app/api/knowledge/[[...kb]]/route.ts` |
| `/` (copilot shell) | Yes | Yes | Shell only; studio backend refuses | `web/app/dash/page.tsx`; `web/app/api/eve/v1/[[...path]]/route.ts` `getTrainerOrg` |
| `/knowledge`, `/domains`, `/voice/cloning/new`, `/users/review` | Redirect | Redirect | Redirect, then target guard | Corresponding `web/app/dash/**/page.tsx`: `/twin/knowledge`, `/agents`, `/voice/cloning`, `/sessions?learner=…&range=all` or `/users` |

### Exact tRPC permission matrix

Mounted together at `/api/trpc` by `web/lib/app-router.ts`; twin and roleplay also have `/api/twin` and `/api/roleplay` transports. Anonymous callers can use only the public rows. Enabled learner-only callers can use protected rows; any studio membership takes precedence when building context (`web/lib/trpc.ts`, `web/lib/org.ts`).

| Procedure names | admin | team | user | Source / primitive |
| --- | --- | --- | --- | --- |
| `page.ownTwinPersona`, `page.twinBrain`, `page.agents`, `page.rolePlayPreview`, `page.agentSpec`, `page.calibrationAgent`, `page.fidelity`, `page.users`, `page.personas`, `page.persona`, `page.personaEdit`, `page.sessions`, `page.session` | Yes | Yes | No | `web/lib/pages/router.ts`, `studioProcedure` |
| `page.twinKnowledge`, `page.talk`, `page.overview`, `page.voices` | Yes | Yes | Yes | Same file, `protectedProcedure`; twin layout still blocks learner visits to `/twin/knowledge` |
| `page.developer` | Keys, `canManageApiKeys: true` | Same | Empty keys, false | Same file, `protectedProcedure` |
| `page.settings` | Organization and team data | Same | Organization data, `team: null` | Same file, `protectedProcedure` |
| `page.sharedSession`, `page.twinLink`, `page.orgHome` | Public | Public | Public | Same file, `publicProcedure`; loader does host/code/identity checks |
| `twin.me`; `twin.agents.list/get/pendingReports/update/shareLink`; `twin.assignments.list/assign`; `twin.sessions.list/reportState/get`; `twin.users.list/get`; `twin.calibrations.list/get/evidence/start/score/rate`; `twin.avatar.get/videoUploadUrl/headshot/save/saveVoice` | Yes | Yes | No | `web/lib/twin/trpc.ts`, all `studioProcedure` |
| `roleplay.scenarios.list/get`; `roleplay.builder.get/personas/save/saveSettings`; `roleplay.sessions.list/get/reportState`; `roleplay.users.orgLearners/list` | Yes | Yes | No | `web/lib/roleplay/trpc.ts`, all `studioProcedure`; no `hideRoleplay` guard |
| `minutes.org/learner/addMany/invite/add` | Yes | Yes | No | `web/lib/minutes-trpc.ts`, all `studioProcedure` |

### API and organization-action permissions matrix

This is the role boundary, not a duplicate of each feature's input/output contract. Every listed role still needs the right org, record ownership, credentials and valid input. Route-file pointers identify the methods; module links below own deeper rules.

| Action / method + path | admin | team | user | Source |
| --- | --- | --- | --- | --- |
| Better Auth organization update; invite/resend/cancel; add member; update non-admin role | Yes | Yes | No | `web/lib/auth-roles.ts`; hooks in `web/lib/auth.ts`; UI calls in `web/components/profile-form.tsx`, `web/components/users/team-section.tsx` |
| Better Auth organization delete | No | No | No | `web/lib/auth-roles.ts`: studio uses `adminAc`, not `ownerAc` |
| Better Auth remove member / change existing admin role / create second admin | No | No | No | `web/lib/auth.ts` hooks; `web/lib/members.ts` |
| Better Auth access-control statements (`ac`) | create/read/update/delete | Same | read | `web/lib/auth-roles.ts` imports `adminAc` / `memberAc`; no custom access-control UI here |
| Better Auth team-resource statements (`team`, distinct from the org role) | create/update/delete | Same | None | `web/lib/auth-roles.ts` inherits `adminAc` / `memberAc`; Better Auth teams are not enabled in `web/lib/auth.ts`, so these statements do not add an app team-management feature |
| Better Auth `apiKey` create/read/update/delete permission | Yes | Yes | No | `web/lib/auth-roles.ts` `organizationAccess`, `organizationRoles` |
| Better Auth set-active org | Own membership | Own membership | Own membership; not shown in studio switcher | `web/lib/auth.ts` organization plugin; `web/components/org-switcher.tsx`; actual studio selection still uses `pickMembership` |
| PATCH `/api/members/:id` (disable/enable) | Yes, not admin/self disable | Same | No | `web/app/api/members/[id]/route.ts` |
| PATCH `/api/org/settings` | Yes | Yes | No | `web/app/api/org/settings/route.ts` |
| GET/POST/DELETE `/api/developer/api-keys` | Yes | Yes | No | `web/app/api/developer/api-keys/route.ts` |
| POST `/api/twins`; GET/PUT/PATCH `/api/twins/:slug/assignments`; GET/POST/PATCH `/api/twins/:slug/share-links`; PUT/DELETE `/api/role-play/:slug/assignments` | Yes | Yes | No | `web/app/api/twins/route.ts`, `web/app/api/twins/[slug]/{assignments,share-links}/route.ts`, `web/app/api/role-play/[slug]/assignments/route.ts`: `getTrainerOrg` |
| POST `/api/agents/:slug/generate`, `/api/agents/visibility`; GET/PUT/DELETE `/api/spec/:type/*`; GET/PATCH `/api/spec-drafts/:slug/:type`; POST `/api/spec-drafts/:slug/publish`; GET `/api/spec-drafts/current` | Yes | Yes | No | Corresponding files under `web/app/api/agents/`, `spec/`, `spec-drafts/`: `getTrainerOrg` |
| POST `/api/personas`; PATCH `/api/personas/:slug`; POST media/synthesize; GET/POST sources; DELETE source; POST source analyze | Yes | Yes | No | `web/app/api/personas/route.ts`, `web/app/api/personas/[slug]/**/route.ts`: `getTrainerOrg` |
| GET `/api/personas/:slug/avatar`; GET `/api/version/:type/:id` | Yes | Yes | Yes | `web/app/api/personas/[slug]/avatar/route.ts`, `web/app/api/version/[type]/[id]/route.ts`: `getSessionOrg` |
| Knowledge documents/stats/search reads: GET `/api/knowledge/documents`, `/stats`, `/search`, `/documents/:id/chunks`, `/documents/:id/preview`, `/:kb/search` | Yes | Yes | Yes | Corresponding `web/app/api/knowledge/**/route.ts`: `getSessionOrg` |
| Legacy knowledge GET/POST/DELETE `/api/knowledge/*` (base/file create, upload, digest, delete) | Yes | Yes | Yes | `web/app/api/knowledge/[[...kb]]/route.ts`: `getSessionOrg`, not `getTrainerOrg` |
| POST `/api/knowledge/upload`; DELETE/POST `/api/knowledge/documents/:id`; GET `/documents/:id/used-in`; DELETE `/sources/:id`; POST `/sources/:id/refresh`; GET `/connectors`; POST `/connectors/notion`, `/connectors/youtube`, `/connectors/youtube/preview`, `/:kb/notion`, `/:kb/youtube`; DELETE `/connections/:id` | Yes | Yes | No | Corresponding `web/app/api/knowledge/**/route.ts`: `getTrainerOrg` |
| Connector OAuth start/callback for Notion, YouTube and Drive; POST Drive import; GET/DELETE Drive session | Yes | Yes | No | `web/app/api/connectors/{notion,youtube,google-drive}/**/route.ts`: `getTrainerOrg`; local callback bridge is not an org-role action |
| GET/POST `/api/tts/voices`; PATCH/DELETE `/api/tts/voices/:voiceId` (cloned voices only) | Yes | Yes | Yes | `web/app/api/tts/voices/route.ts`, `web/app/api/tts/voices/[voiceId]/route.ts`: `getSessionOrg` |
| GET `/api/copilot/me`; GET/POST `/api/eve/v1/*`; POST `/api/uploads` with purpose `copilot` | Yes | Yes | No | `web/app/api/copilot/me/route.ts`, `web/app/api/eve/v1/[[...path]]/route.ts`, `web/app/api/uploads/route.ts`: `getTrainerOrg` |
| GET `/api/sessions` | Yes | Yes | No | `web/app/api/sessions/route.ts` GET: `getTrainerOrg` |
| POST `/api/sessions` | Studio try or usable practice link | Same | Usable share code; deployment-key path requires membership; no bare agent-slug try | `web/app/api/sessions/route.ts`; `web/lib/interview-sessions.ts` |
| GET `/api/sessions/:id`, `/:id/audio`, `/:id/video` | Any session in resolved org | Same | Own session only | Respective `web/app/api/sessions/[id]/**/route.ts`; GET detail also accepts matching runtime token |
| POST `/api/sessions/finalize`, `/:id/feedback`, `/:id/documents` | Own session only | Same | Own session only | Respective `web/app/api/sessions/**/route.ts`; no studio ownership bypass |
| POST `/api/upload`; POST `/api/uploads` for non-copilot purpose | Member or usable practice-code holder | Same | Same, may precede membership | `web/lib/upload-access.ts` `uploader`; `web/app/api/upload/route.ts`; `web/app/api/uploads/route.ts` |
| `/api/v1/*`, including DELETE `/api/v1/users/:id` | Key required; role alone insufficient | Same | Same | `web/lib/external-api.ts`; DELETE disables an enabled `user` membership only (`web/app/api/v1/users/[id]/route.ts`) |

Runtime-token session commands/lifecycle, internal shared-secret endpoints, payment webhooks and TTS service credentials are **not** privileges attached to admin/team/user. For example PATCH `/api/sessions` requires a runtime token and GET `/api/tts/voices/:voiceId` requires `TTS_APP_KEY`, unlike its member-level PATCH/DELETE. Public GET `/api/portal/agents` needs no member role and returns public runnable role plays for a supplied/resolved org. Sources: `web/app/api/sessions/route.ts` PATCH; `web/app/api/tts/voices/[voiceId]/route.ts` GET; `web/app/api/portal/agents/route.ts`. See [Sessions](sessions.md), [Public API](public-api.md), [Personas and voice](personas-and-voice.md), [Platform](platform.md).

## Entry points

- Studio pages and tRPC procedures: exact matrices above. Transports: `web/app/api/trpc/[trpc]/route.ts`, `web/app/api/twin/[[...route]]/route.ts`, `web/app/api/roleplay/[[...route]]/route.ts`; composed by `web/lib/app-router.ts`.
- Member enable/disable: PATCH `/api/members/:id` (`web/app/api/members/[id]/route.ts`); integrator disable: DELETE `/api/v1/users/:id` (`web/app/api/v1/users/[id]/route.ts`).
- Branding: PATCH `/api/org/settings` (`web/app/api/org/settings/route.ts`), plus Better Auth organization update through `/api/auth/*` (`web/app/api/auth/[...all]/route.ts`, `web/lib/auth.ts`).
- Org creation / slug availability: POST/GET `/api/onboarding` (`web/app/api/onboarding/route.ts`); see [Auth](auth.md) for founder invite/sign-in flow. `web/lib/slugs.ts` `validateOrgSlug` controls reserved names and slug syntax, not the settings form.
- Switcher / pin: `web/components/org-switcher.tsx`, `web/components/org-pin.tsx`, `web/lib/org-switch-path.ts`. Host routing: `web/proxy.ts`; learner identity/org resolution: `web/lib/session-user.ts`.
- No org-disable cron or enable/disable email is sent by `setMemberDisabled`. Invitation emails are delegated to `web/lib/invite/org-hooks.ts` / `web/lib/email.ts`; see [Invites and emails](invites-and-emails.md).

## Talks to

| Module / service | Boundary | Source |
| --- | --- | --- |
| [Auth](auth.md) / Better Auth | Supplies identity, cached session, active-org preference and organization-role access checks. This module re-reads enabled memberships. | `web/lib/auth.ts`, `web/lib/org.ts`, `web/lib/auth-roles.ts` |
| PostgreSQL / Prisma | Stores org, membership, invitation and session preferences; enforces role CHECKs. | `web/prisma/schema.prisma`; role migration above |
| [Invites and emails](invites-and-emails.md) | Studio requests a team/user invite; acceptance gives the org role. Assignment-link practice can create learner membership separately. | `web/components/users/invite-user.tsx`; `web/lib/invite/accept.ts`; `web/lib/interview-sessions.ts` |
| [Twins](twins.md), [Role plays](roleplays.md), [Sessions](sessions.md) / LiveKit | Disable hands off assignment revocation and active-call closure, preserving history. Learner activation must refuse disabled members. | `web/lib/members.ts`; `web/lib/session-lifecycle.ts`; `web/lib/interview-sessions.ts` |
| [Credits](credits.md) | Studio can manage credits; billed team/admin voice calls spend org credits directly (chat and unbilled staff calls stay free). Disable does not modify ledger balances. | `web/lib/minutes-trpc.ts`; `web/lib/members.ts`; `web/lib/pages/learner.ts` |
| [Knowledge](knowledge.md) / Chroma | Org ID scopes storage; onboarding provisions its Chroma database. | `web/app/api/onboarding/route.ts`; `web/lib/chroma-tenant.ts` |
| [Public API](public-api.md) | Verifies key scopes and resolves org from key; API learner role spelling stays `member`. | `web/lib/external-api.ts` |
| [Learner portal](learner-portal.md) | Receives host-selected org, website/accent, and public trainer information; performs practice access checks rather than assuming tRPC membership. | `web/lib/session-user.ts`; `web/lib/pages/org-home.ts`; `web/lib/pages/learner.ts` |

## Edge cases and limits

- **Exactly-one admin is not a database invariant.** Hooks count existing admins before a write, without a lock or unique admin index. Direct database writes can create zero/multiple admins; concurrent additions to an admin-less org are not serialized here. No transfer-admin flow exists. Sources: `web/lib/members.ts` `assertNoSecondAdmin`; `web/lib/auth.ts`; `web/prisma/schema.prisma` `Member`.
- **Duplicate memberships are not schema-blocked.** `ensureLearnerMember` checks then inserts and catches failures, but there is no unique user/org pair in the model. Selection/disable use individual rows; simultaneous first starts may need independent verification. Sources: `web/lib/interview-sessions.ts` `ensureLearnerMember`; `web/prisma/schema.prisma` `Member`.
- **Call closure is after commit.** A closure failure can leave membership/assignment revocation committed but some rooms unclosed. Retrying disable sees `disabledAt` and returns before retrying closure. `closing` sessions are not included in the live-close query. Source: `web/lib/members.ts` `setMemberDisabled`.
- **Re-enable is not undo.** The function does not restore practice assignments, auth sessions or invitations and does not reset credits. It leaves `used` role-play assignments unchanged on disable. Source: `web/lib/members.ts`.
- **Pin fallback is not an error.** If the pinned membership is lost, selection can move to another org. Full reloads follow active-org preference rather than the old tab pin. Sources: `web/lib/org.ts` `pickMembership`; `web/components/org-pin.tsx`.
- **Switch-path shortcut:** static child segments are mirrored by hand. A new static subpage absent from `STATIC_SEGMENTS` will be treated as a record ID and truncated after switch. Record IDs matching a static word are kept. Source: `web/lib/org-switch-path.ts` comment and `pathAfterOrgSwitch`.
- **Branding shortcuts:** small logos are kept inline, not S3; metadata remains JSON text; brand and strong-brand use the same color; white foreground has no contrast check. These are explicit comments in `web/components/profile-form.tsx`, `web/lib/org.ts`, `web/components/org-accent-provider.tsx`.
- **Slug validation copy is stricter than its regex:** the message says 3–30 characters, but a single alphanumeric character also matches. Settings does not edit slug. Sources: `web/lib/slugs.ts` `validateOrgSlug`; `web/components/profile-form.tsx`.
- **Disabled is not a universal read guard.** On a portal host, `resolveSessionUser` returns signed-in identity without checking `disabledAt`. `isStudioMember`, recording/detail role lookups and `uploader` also omit it. A cached cookie or another enabled org can therefore keep portal reads/upload paths available; activation is separately blocked. Sources: `web/lib/session-user.ts`; `web/lib/pages/learner.ts` `isStudioMember`; `web/app/api/sessions/[id]/{route.ts,audio/route.ts,video/route.ts}`; `web/lib/upload-access.ts`; `web/lib/interview-sessions.ts` `activateSession`.
- **Keys outlive member disable.** `setMemberDisabled` does not delete/disable API keys; `requireExternalApi` verifies key and org without re-checking its creator's enabled membership. Source: `web/lib/members.ts`; `web/lib/external-api.ts`.

## Mismatches

| Intent / copy | Code today |
| --- | --- |
| `plans/twin-roleplay-db-split.md` §13 and `plans/prod-release-v2.md` §2B say users have no studio access / only practise. | Protected loaders allow overview, voice library, knowledge data, developer landing and settings; legacy knowledge and cloned-voice endpoints allow mutations for `user`. Sources: `web/lib/pages/router.ts`; `web/app/api/knowledge/[[...kb]]/route.ts`; `web/app/api/tts/voices/**/route.ts`. |
| `plans/twin-roleplay-db-split.md` §13 describes a single-org lock and first/home-org restriction; `web/components/users/invite-user.tsx` still comments “one org per person”. | Multi-org enabled memberships are supported and studio selection prefers pin/active/oldest. Founder onboarding accepts an existing member. `plans/milestone-2026-11-06.md` open list now explicitly calls out multi-org invites and two-tab testing. Sources: `web/lib/org.ts`; `web/app/api/onboarding/route.ts`. |
| `plans/prod-release-v2.md` §2F says `/users` was removed in favor of Settings → Team. | `/users` is a live activity page with `/users/:id` detail, alongside Settings Team. Sources: `web/app/dash/users/page.tsx`, `web/app/dash/users/[id]/page.tsx`; `web/lib/pages/router.ts` `users`. |
| Developer-page copy says “Only organization owners and admins can manage API keys.” | There is no `owner` role; both admin and team can manage keys. Sources: `web/app/dash/developer/page.tsx`; `web/lib/auth-roles.ts`; `web/app/api/developer/api-keys/route.ts`. |
| Disable-confirmation copy says “They are signed out” and “lose their twin and role-play access”; the schema comment says disabled people cannot sign in. | Auth sessions are deleted only on last-enabled-membership disable. Used role-play assignments remain, and some portal reads do not guard disabled state. Session activation does refuse disabled members. Sources: `web/components/users/team-section.tsx`; `web/prisma/schema.prisma` `Member`; `web/lib/members.ts`; `web/lib/session-user.ts`. |
| `web/lib/org.ts` describes `hideRoleplay` as “no Role play menus or pages”. | It gates only the layouts/presentation listed in Rule 8, not all role-play APIs or legacy pages. Sources: `web/lib/roleplay/trpc.ts`; `web/lib/pages/router.ts`; `web/app/api/portal/agents/route.ts`. |

`PRODUCT.md` does not specify organization roles, disable semantics or switching, so it supplies no more specific contract to reconcile here.

## Open questions

1. Should “users only practise” forbid the protected overview/knowledge/voice loaders and legacy mutations, or is this intended compatibility? The plan's no-studio table disagrees with these guards. Pointers: `plans/twin-roleplay-db-split.md` §13; `web/lib/pages/router.ts`; `web/app/api/knowledge/[[...kb]]/route.ts`; `web/app/api/tts/voices/route.ts`.
2. Must disabling block all portal reads/uploads and organization-plugin calls immediately, including cached-session and multi-org users? Central enabled filtering exists only for studio-style selection; portal identity and several direct membership checks omit it. Pointers: `web/lib/org.ts` `enabledMemberships`; `web/lib/session-user.ts`; `web/lib/upload-access.ts`; `web/lib/auth.ts` organization hooks; `web/app/api/sessions/[id]/audio/route.ts`.
3. Should used role-play access be cancelled and creator API keys revoked on disable, or intentionally retained behind activation checks/key validity? Pointers: `web/lib/members.ts` `setMemberDisabled`; `web/lib/pages/learner.ts` `loadSharedSession`; `web/lib/external-api.ts` `requireExternalApi`.
4. Is `hideRoleplay` only presentation, or a complete feature restriction? Pointers: `web/lib/org.ts` `requireRoleplayOrg`; `web/lib/roleplay/trpc.ts`; `web/app/api/portal/agents/route.ts`.
5. Must exactly-one-admin and one-membership-per-org survive concurrent/direct writes, and how is admin transfer/recovery meant to work? Current hooks and schema provide different strengths of guarantee. Pointers: `web/lib/members.ts` `assertNoSecondAdmin`; `web/lib/auth.ts` `beforeUpdateMemberRole`; `web/prisma/schema.prisma` `Member`.

## Tests today

| Layer | Existing coverage / state |
| --- | --- |
| Unit: members | `web/tests/lib/members.test.ts`: second admin check, self/admin disable rejection, transaction calls, live closure, re-enable, multi-org sign-in. Focused run: **5 passed**. Mocks do not prove database concurrency or real LiveKit closure. |
| Unit: org resolution | `web/tests/lib/org-membership.test.ts`: exact selection order, untrusted/learner pin ignored, studio-only switcher list. **3 passed**. `web/tests/lib/org-switch-path.test.ts`: preserved list/query and truncated record routes. **2 passed**. |
| Unit: metadata | `web/tests/lib/org-flags.test.ts`: literal-true `hideRoleplay`, malformed/absent metadata. **1 passed**. |
| Unit: page authorization | `web/tests/lib/page-router-access.test.ts`: intended learner/anonymous/org-less guards and disabled-context filtering. Current isolated run: **1 passed, 2 failed** because its table calls removed `page.learners` instead of `page.users` and receives `NOT_FOUND`; not proof that the replacement is unguarded. |
| Unit: calibration | `web/tests/lib/calibration-access.test.ts`: intended page and tRPC studio guard coverage; not run for this spec. Its membership mock uses `findFirst`, while current `enabledMemberships` uses `findMany`. |
| API authorization | `web/tests/api/learner-session-access.test.ts`: intended recording/session access checks. Current isolated run fails during import: mocked org module lacks `isStudioRole`. `web/tests/api/v1-users-contract.test.ts`, `v1-assignments-isolation.test.ts`: API learner role/tenant contracts; not run here. |
| Database / SQL | `web/tests/sql/org-roles.sql`: allowed roles, invalid spellings and defaults, not exactly-one admin. `web/tests/sql/twin-access.sql`: studio assignment bypass and learner twin access. `web/tests/lib/minutes-stage-two-trpc.db.test.ts`, `minutes-stage-two-lists.db.test.ts`, `minutes-learner-page.db.test.ts`: admin/team credit restrictions and preview behavior. Not run here. |
| Flows / browser | `web/tests/flows/trainer-credits.flow.test.ts`, `web/e2e/trainer-credits.spec.ts`, `web/e2e/credits.spec.ts` exercise adjacent studio credit flows. No dedicated browser org-switch/settings/disable suite was found; the milestone plan also lists two-tab org switching as not browser-tested. Not run here. |
| Python / chat | None dedicated to org membership selection/role management. Runtime behavior belongs to [Voice agent and chat](voice-agent-and-chat.md). |

Most important missing checks: real two-tab fetch pin and cache isolation; invalidated-pin fallback after disable; API/Better Auth actions with cached disabled identities; used role-play/keys after disable; closure failure and retry; concurrent first membership/admin creation; branding's partial save and server/client validation difference. Sources for these boundaries are listed in *How it works* and *Edge cases and limits*. Only the four passing focused unit suites and two failing authorization suites above were run for this documentation change.
