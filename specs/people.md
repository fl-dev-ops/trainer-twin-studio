# People: accounts, org members, assignments, sign-in and their emails

> **A rule spec.** It says how people *must* work; the code follows it, and a difference is a bug in the code. Every
> other spec that touches people ([Orgs and roles](orgs-and-roles.md), [Invites and emails](invites-and-emails.md),
> [Auth](auth.md), [Twins](twins.md), [Role plays](roleplays.md), [Credits](credits.md)) must agree with it.
> Agreed 11 Nov 2026 (`plans/people-and-sign-in.md`).

## Who uses it

| Actor | What they do here |
| --- | --- |
| Org admin / team (studio) | Add people to the org (any role); assign twins and role plays; give learner credits; disable people. |
| Learner (`user`) | Signs in and practises what they were given. |
| API integrator | Adds learners and role-play assignments with an org API key. |
| Copilot (for a studio member) | Adds learners and assigns twins / role plays. |
| Existing account with a shared twin link | Signs in, and is added to the org as a learner with that twin. |

## Words used here

| Term | Meaning (code name) |
| --- | --- |
| Account | A person on TrainerTwin (`user`), one per email. |
| Member | An account's place in one org, with a role (`member`: `admin`, `team` or `user`) and enabled / disabled. |
| Assignment | A member's access to one twin (`TwinAssignment.userId`) or role play (`RolePlayAssignment.memberId`). |
| Org's people | The org's members, from `orgPeople` in `web/lib/org-people.ts`. |

## Rules

1. **Account first.** Adding an email to an org creates its account when none exists (lower-cased email, name from
   the part before `@`). Operators also create founder accounts with `web/scripts/founder-invite.ts`. Sign-in never
   creates an account.
2. **Then a member.** The account becomes a member of the org with the chosen role in the same action. There is no
   "invited, not joined" state for any role: a member just signs in. One member row per account per org (database
   unique `(organizationId, userId)`).
3. **Then an assignment.** A twin or role-play assignment always points at a member: `TwinAssignment.userId` and
   `RolePlayAssignment.memberId` are required (database `NOT NULL`). There is no assignment by email alone.
4. **Access is by account.** Whether someone may open a twin or role play is decided by their signed-in account's
   assignment in that org, never by matching an email.
5. **One list.** The org's people come only from `web/lib/org-people.ts` (`orgPeople`, `orgPerson`). Every page, API
   and workflow in `web/` that lists or looks up an org's people uses it; a test fails on any other direct read of
   `member` lists.
6. **One way in.** Every entry point that adds people (Settings, assign twin, assign role play, REST API, copilot,
   shared twin link, when its page is opened) calls `addPeopleToOrg`. Session start never creates a member; it refuses
   someone who isn't one.
7. **Roles.** One admin per org: adding a second admin is refused. Adding someone already in the org keeps their role
   (no role change through "add"). A learner assign (twin / role play) refuses admin and team people, who practise
   from the org's credits instead (see [Credits](credits.md)).
8. **Disabled stays disabled.** Adding or assigning a disabled member is refused with a message to re-enable them.
9. **Learner credits.** A new learner gets their starting credits when they're added (once per org, as today; see
   [Credits](credits.md)). Starting credits are all or nothing for a batch: when the org can't cover them, nobody is
   added.
10. **Sign-in is Google or an email code.** No passwords anywhere (no password sign-in, sign-up or reset). The code
    is 6 digits, valid 10 minutes, 3 tries, sent through Resend. Only existing accounts may sign in, through either
    method; operators create founders and org admins/team add other people. Unknown emails receive a generic success
    response to a code request, but no code is sent and no account is created. Signing in alone gives no org access.
    In development only, when Resend is not configured, the OTP is printed in the dev-server terminal instead.
11. **Emails.** Each action sends one email per affected person, combining what applies:

    | Action | Email says |
    | --- | --- |
    | Added to an org | who added you, the org, your role, how to sign in (link: org home for learners, the studio for admin/team) |
    | Twin assigned | the twin, until when, your credits, the link |
    | Role play assigned | the role play, its objective, what to prepare, your credits, the link |
    | Learner credits added | how many, the new balance |
    | Org credits added (to the org admin) | how many, the new org balance, expiry |

    A brand-new learner given a twin gets one email covering "added", the twin and their credits. Joining through a
    shared twin link sends none. Each email is sent at most once per event (Resend idempotency key).
12. **Emails go out through workflows** (`web/workflows/`), each email retried on its own. A failed email never undoes
    the action. Two exceptions, both keeping the email's idempotency key: the REST API sends at once so its response
    can say `emailSent` (a failure is then retried by the workflow), and when a workflow can't start the emails are
    sent directly.

13. **Only the sign-in routes we use are open.** `/api/auth/*` answers only: `GET /get-session`, `POST /sign-out`,
    `GET /ok`, `GET /error`, `POST /email-otp/send-verification-otp`, `POST /sign-in/email-otp`,
    `POST /sign-in/social`, `GET|POST /callback/google`, `POST /organization/set-active` and `POST /update-user`
    (name only). Every other path or method is `not_found` with nothing written, including anything a Better Auth
    update adds. Better Auth's own member actions (add, invite, remove, leave, change role) are refused even when
    called from server code.
14. **Access is checked against the database on every request.** A login is cached in its cookie for up to 5
    minutes, so "has a login" never means "may use this org": every studio and portal check reads the person's
    member row (enabled, role) from the database. Proxy cookie checks only route pages.
15. **The studio is for admin and team.** Learners get the portal (their org home, twin and practice pages) and
    their own account (name, sign out). Every studio page loader, tRPC procedure and API route refuses them with
    `studio_only` — including the overview, talk, voices, developer, knowledge, version and TTS routes (speech too:
    only studio members, or the voice agent with the TTS key) and the team, branding and billing parts of Settings.
16. **A tab's org must still be yours.** A request with the tab's org header (`x-trainertwin-org`) is served only
    for that org, and only while the person is an enabled admin/team member of it; otherwise `org_pin_invalid`
    (the tab must reload). Without the header the org is picked as before (pinned → active → oldest studio org).
17. **People changes in one org happen one at a time.** Adding people (with their starting credits), disabling,
    re-enabling and changing a role take the org's people lock and re-check the rules inside it. A batch is all or
    nothing: checks, starting credits (only for learners added by this call) and member rows commit together.
18. **Disabling** keeps the person's history and turns off what they could still use in that org: active twin
    assignments, pending role plays, practice sessions not yet started, and any call in progress (ended at once).
    Their logins are deleted when no enabled membership is left. Disabling an already-disabled person changes
    nothing but still ends any call left running. Ending one call failing never stops the others. The admin and
    yourself can't be disabled. Re-enabling restores the membership only; assignments are given again.
19. **Changing a role** is team ↔ learner only, by staff with `web/scripts/set-member-role.ts` (no page or API
    does it). Becoming team removes the person's learner assignments in the same transaction. The admin's role
    never changes and nobody becomes admin this way (how to hand over an admin is an open question).
20. **Founder onboarding** uses a founder token once: it is spent in the same transaction that creates the org and
    its admin, so two requests with one token make one org. A taken subdomain is `slug_taken` and spends nothing.
    Once the org exists it is never deleted because a later step (switching to it, starting a connector) failed.
21. **Org settings** are saved in one request (`PATCH /api/org/settings`): name, logo (PNG/JPEG/WebP, at most
    1,000,000 bytes), website (HTTPS or empty) and accent colour (#RGB/#RRGGBB). The subdomain can't be changed and
    other settings (such as hiding role plays) are staff-only; the request can't touch them.
22. **API keys belong to a person.** A key acts for the enabled admin/team member who created it. A key without a
    creator, or whose creator is no longer an enabled admin/team member, is refused (`api_key_owner_gone`).
23. **Every refusal is ours.** Each refusal has a code, a status and a message from the table below, and the same
    condition gives the same code, status and message wherever it is checked. Routes answer `{ error, code }`;
    tRPC errors keep their tRPC code and carry ours in `data.refusal`. Anything not described in these rules is refused.

## Checks (must always hold; `web/scripts/check-org-people.ts`)

- Every member has an account; no account has two member rows in one org.
- Every twin assignment has `userId`, and that account is a member of the assignment's org.
- Every role-play assignment has `memberId`, and that member is in the assignment's org.
- No admin or team member holds a twin or role-play assignment (moving someone to the studio removes theirs).
- Every learner credits row (`MinuteLedger` types `grant`, `usage`, `reclaim`) belongs to an email that is a member of
  that org.
- Every org has exactly one admin (also a database unique index).
- No disabled member holds an active twin assignment, a pending role play or a call in progress.

Run in the test suites, in every release rehearsal, and after every release.

## Refusals

One row per condition. **Where**: P proxy, PG page loader, T tRPC, R route handler, S service, BA Better Auth hook,
DB database constraint — every layer listed must refuse it. Each code appears in at least one test title as
`refuses <code>` (checked by `web/tests/specs-refusals.test.ts`). Better Auth's own sign-in errors (wrong, expired
or used-up code; Google `signup_disabled`) keep its codes and are shown by the sign-in page.

| Code | Status | Message | When | Where |
| --- | --- | --- | --- | --- |
| `not_found` | 404 | Not found. | A record that doesn't exist, is deleted, or belongs to another org; any closed `/api/auth` route (rule 13) | R, T, S |
| `signed_out` | 401 | Sign in first. | No login on a page or route that needs one | P (dash pages), PG, T, R |
| `no_org` | 403 | You're not a member of this organization. | Logged in, but no enabled membership in the org asked for | PG (to `/auth/no-org`), T, R |
| `studio_only` | 403 | Only the organization's admin and team can do this. | A learner on a studio page, procedure or route (rule 15) | PG, T, R |
| `org_pin_invalid` | 403 | This tab's organization is no longer available to you. Reload the page. | Tab org header isn't an enabled admin/team membership (rule 16) | T, R |
| `member_disabled` | 403 | Your access to this organization has been turned off. Ask its admin to turn it back on. | The signed-in person is disabled in the org asked for (tab org header), or in every org they belong to (all orgs: also at sign-in) | BA (sign-in), PG, T, R, S |
| `person_disabled` | 409 | {email} is disabled in this organization. Re-enable them first. | Adding, assigning or giving credits to a disabled person | S |
| `person_is_studio` | 409 | {email} is on the team. Team members practise with the organization's credits, not as learners. | A learner action (add as learner, assign, learner credits) for admin/team | S |
| `invalid_email` | 400 | Not a valid email: {email} | Adding people with a malformed email | S |
| `invalid_input` | 400 | (what is wrong, per field) | A request body that fails its schema | T, R |
| `one_admin` | 409 | This organization already has an admin. Add people as team or learner. | Anything that would make a second admin | S, BA, DB |
| `admin_fixed` | 403 | The admin's role can't be changed and the admin can't be disabled. | Disabling or changing the role of the admin | S, BA |
| `calls_not_ended` | 500 | Disabled, but {n} call(s) in progress could not be ended yet. Disable again to retry. | Disabling committed but ending a running call failed (rule 18) | S |
| `self_disable` | 400 | You can't disable yourself. | Disabling your own membership | S |
| `member_action_closed` | 403 | Add, change and disable people from Settings. | Better Auth add/invite/remove/leave/role change (server code) | BA |
| `token_invalid` | 400 | This setup link is invalid or already used. | Founder token missing or spent | R, S |
| `token_email_mismatch` | 403 | This setup link is for a different email address. | Signed-in email isn't the token's email | S |
| `slug_invalid` | 400 | (why the subdomain isn't allowed) | Subdomain fails the 3–30 character rule or is reserved | S |
| `slug_taken` | 409 | That subdomain is taken. | Subdomain already used (including at the same moment) | S, DB |
| `onboarding_failed` | 500 | Could not create the organization. Try again. | Setting up the new org (database, billing) failed; it is undone and the link works again | S |
| `logo_invalid` | 400 | Use a PNG, JPEG or WebP logo up to 1 MB. | Org logo of another type or too big | S |
| `api_key_owner_gone` | 403 | This API key's owner is no longer on the team. Create a new key. | Key with no creator, or creator not an enabled admin/team member (rule 22) | S |


## Open questions

- **Handing over an admin** (the admin leaves the company): the admin can't be disabled or changed (rules 18–19). Today only a manual database change does it.
- **Founder tokens never expire.** Fine while operators create them by hand.
