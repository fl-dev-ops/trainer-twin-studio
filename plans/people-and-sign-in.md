# People, sign-in and emails: plan

Status: **draft for review** (11 Nov 2026). Nothing is built yet.

## What went wrong

Twin and role-play assignments are tied to an **email address**, not to a person in the org. A person becomes an org
member only when they start their first call (`ensureLearnerMember` in `web/lib/interview-sessions.ts`). So the app
has three kinds of "people" (members, pending invitations, emails on assignments), and every page lists a different
mix of them:

| Page | Reads |
|---|---|
| Twin users, the twin's Learners tab | twin assignments by email |
| Users | members + assignments + sessions, merged by email |
| Settings › Team / Users | members + invitations + "waiting" assignment emails |
| REST API `GET /api/v1/users` | members + invitations |

That is why prod showed harini, Surya and t.nesa07 on some pages and not others, and why the phase 1 clean-up (which
removed people by member row) missed them. The spec (`specs/orgs-and-roles.md`) described this behaviour as it was,
so no review caught that it was the wrong rule. It also let anyone sign up with a password using someone else's email
and get that person's twin, because access was matched by email.

## The rules (the target)

1. **A person is a user first.** Adding someone to an org creates their account (`user`) if it doesn't exist.
2. **Then a member of the org**, with a role: `admin`, `team` or `user`. There is no "invited, not joined" state: once
   added, they are a member and just sign in (Google or an email code). This is the same for every role.
3. **Only then a twin or role play.** An assignment always points at that person (`userId` / `memberId`), never only
   at an email. Access is checked by account.
4. **One list of an org's people**, from one service (`web/lib/org-people.ts`). Every page, API and workflow in `web/`
   that lists or looks up an org's people goes through it.
5. **Sign-in is Google or a one-time email code** (sent through Resend). No passwords.
6. **Every change a person should know about sends one email**: added to an org, twin assigned, role play assigned,
   credits added.

The database enforces rules 2 and 3, so the wrong state can't be stored again (see "Data").

## Decisions needed (my recommendation in bold)

| # | Question | Recommendation |
|---|---|---|
| D1 | A brand-new person assigned a twin triggers "added", "twin assigned" and "credits added" at once. Three emails, or one? | **One email per action**, built from those parts (e.g. "Olga added you to Olga's workspace and gave you her twin, with 30 credits"). Later separate events (more credits, another twin) send their own email. |
| D2 | "Credits added": learner credits only, or also org credits? | **Both**: a learner gets an email when a trainer gives them credits; the org admin gets one when org credits arrive (Meteroid grant / top-up, via the webhook). |
| D3 | Admin/team invites today need accepting on an invite page. Same direct "add" as learners? | **Yes** (your "irrespective of the role"). The one-admin rule stays. |
| D4 | Someone who joins through a shared twin link (they're signing in on the page) | **No email**; they're added as a member and given the twin on the spot. |
| D5 | Learner credits are kept per email (`MinuteLedger.email`). | **Keep for now**: every learner is now a user with that email, so it stays correct. Move to `userId` later (noted in code). |
| D6 | The 8 prod accounts that use a password today | **Nothing to do**: they sign in with Google or an email code to the same address and keep everything. |

## Changes

### 1. Specs first

Rewrite the rules above into `specs/orgs-and-roles.md`, `specs/invites-and-emails.md` and `specs/auth.md` **before**
code, and get your review. The code and tests then follow the spec, not the other way round.

### 2. Data (one Prisma migration, safe to run again)

1. Duplicate `member` rows (same person, same org): keep one, the highest role.
2. Add a unique `(organizationId, userId)` on `member`.
3. Backfill: every email on a twin or role-play assignment, or on a pending invitation, that isn't a member gets a
   `user` (if missing) and a `member` (the invitation's role, else `user`); the assignment gets its `userId` /
   `memberId`.
4. `TwinAssignment.userId` and `RolePlayAssignment.memberId` become **required**. `recipientEmail` is removed from
   both (the email lives on the user). Twin uniqueness becomes `(agentId, userId)`.
5. Pending invitations are closed (status `accepted`, as they're now members). The `invitation` table stays, unused,
   until a later clean-up.

In prod, after the leftover clean-up (step 0 below), the backfill finds nothing to do.

### 3. The people service: `web/lib/org-people.ts`

- `addPeopleToOrg({ orgId, emails, role, by })`: finds or creates each user, then the member. Refuses a second admin;
  refuses changing an existing member's role here; a disabled member stays disabled (reported back). Returns the
  people, marking who is new.
- `orgPeople(orgId, { roles?, includeDisabled? })`: the org's people (member id, user id, name, email, image, role,
  disabled, added at).
- `orgPerson(orgId, { userId | email })`: one person, or null.
- Starting credits for new learners stay where they are (given when a learner is added), now called from here.

### 4. Every way people are added goes through it

| Entry point | Today | After |
|---|---|---|
| Settings › Users / Team "Invite" (any role) | Better Auth invitation, accepted later | `addPeopleToOrg`, then the "added" email |
| Twin assign (page, copilot, REST API) | assignment by email | `addPeopleToOrg` (learners) → assignment by `userId` → email |
| Role-play assign (page, copilot, REST API) | assignment by email | `addPeopleToOrg` → assignment by `memberId` → email |
| REST API `POST /api/v1/users` | invitation | `addPeopleToOrg` → email |
| Shared twin link | assignment on sign-in, member on first call | on sign-in: `addPeopleToOrg` (self) → assignment |
| Session start | creates a missing member | requires the member (never creates one) |
| Org home / invite page | accepts a pending invitation | nothing to accept; removed |

### 5. Every list reads `orgPeople`

Settings › Team and Users, Users, Twin users, the twin's Learners tab, role-play users, the assign dialogs' people
picker, REST API `GET /api/v1/users`, the copilot, credits per learner. "Invite sent" / "Invite pending" and the
"waiting" list go away. Counts match the rows.

### 6. Emails (Resend, through workflows)

New templates in `web/lib/email.ts`, one per event, each with the org's name and a sign-in link (learners: their org
home; admin/team: the studio):

1. **Added to an org**: who added you, your role, how to sign in (Google or email code).
2. **Twin assigned**: the twin, until when, your credits, the link.
3. **Role play assigned**: the role play, its objective, anything to prepare, the link.
4. **Credits added**: how many, your new balance, and expiry if any (learner); for org credits, the admin gets the
   amount, new org balance and expiry.

Per D1, one action sends one email that combines the parts that apply.

### 7. Workflows (one per file, header comment, steps in `workflows/steps/`)

| Workflow | Change |
|---|---|
| `invite-org-learners.ts` | Becomes `add-org-people.ts`: add people (any role), starting credits for learners, then emails. |
| `assign-twin.ts`, `assign-roleplay.ts` | Add people to the org first, then assign, then one email each (D1). |
| `invite-emails.ts` | Becomes `send-emails.ts`: delivers any of the new emails, each retried on its own (same live progress for the screens). |
| new `give-credits.ts` | Users page "Add credits" (one or many learners): give credits, then the credits email. Today it's a plain request. |
| `sync-org-credits.ts` | When Meteroid reports new org credits, also emails the admin (D2). Once per grant. |
| `start-session.ts` | No longer creates a member. |

### 8. Sign-in: Google + email code

- Better Auth `emailOTP` plugin; the code goes out through Resend with the existing `sendOtpEmail` template (6 digits,
  10 minutes, 3 attempts, rate-limited).
- Email-and-password sign-in, sign-up and password reset are removed (forms, routes, the reset email).
- Sign-in page: "Continue with Google" or "Email me a code". The sign-up page goes; the first sign-in creates the
  account (needed for shared twin links).
- Founder onboarding: sign in first (Google or code), then the org form, with no password fields.
- Google sign-in for someone added before they ever signed in: allowed (`requireLocalEmailVerified: false`). Safe
  once passwords are gone, since no account can hold a password someone else set.

### 9. Tests (written by the test-writer agent `azure-tt/gpt-6-1-sol`, run by me)

- `org-people` unit and DB tests: add (new user, existing user, existing member, second admin, disabled, duplicates,
  mixed case emails), list, look up.
- Flow tests for every entry point in section 4, each ending with the **invariant check** below.
- Emails: each event sends exactly the expected email once; retries don't send twice.
- Sign-in: Google, email code (right, wrong, expired), no password routes.
- **Invariant check** (`web/scripts/check-org-people.ts` plus a test helper): every assignment has its member, every
  member has a user, no duplicate members, no assignment without a person. Used by tests, rehearsals and after
  every release.
- **Architecture test**: fails if any file in `web/` other than `lib/org-people.ts` reads `member` or assignment
  people lists directly, so the one-service rule can't drift.
- e2e: add a person, assign a twin and a role play, give credits, sign in with a code, and check that every list page
  shows the same people.

### 10. Rehearsal, then release (each prod step needs your go-ahead)

1. A fresh prod copy locally: migration, the invariant check, every flow, every list page compared with the database
   (screenshots), the four emails received.
2. Prod: backups → migration (runs with the deploy) → invariant check → the same page checks.

## Step 0, before all this

Run the fixed leftover clean-up in prod (already tested on a prod copy), so the backfill doesn't turn harini, Surya
and t.nesa07 into members of olga.

## How we avoid this going forward

1. **Rules before code**: every data rule is written in the spec first, as a rule ("a person is a member before they
   get a twin"), and you review it. Specs no longer just describe whatever the code does.
2. **The database enforces the rules** (required links, unique members), so a wrong state fails loudly instead of
   being stored.
3. **One service per concept** (people now; credits already), guarded by an architecture test.
4. **An invariant check** runs in tests, in every rehearsal and after every release; a release isn't done until it
   passes.
5. **Rehearsals check what people see**: every list page against the database, not only counts.

## Order of work

0. Prod leftover clean-up (go-ahead).
1. Specs (your review) → 2. migration → 3. `org-people` → 4. entry points → 5. lists → 6. emails → 7. workflows →
8. sign-in → 9. tests (alongside each step) → 10. rehearsal → release (go-ahead).

Branch: `org-people` off `v2`, one PR. The current uncommitted Settings count fix is dropped (the "waiting" list it
counted goes away); the clean-up SQL fix is kept for step 0.
