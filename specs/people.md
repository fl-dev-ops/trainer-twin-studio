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
| Anyone with a shared twin link | Signs in, and is added to the org as a learner with that twin. |

## Words used here

| Term | Meaning (code name) |
| --- | --- |
| Account | A person on TrainerTwin (`user`), one per email. |
| Member | An account's place in one org, with a role (`member`: `admin`, `team` or `user`) and enabled / disabled. |
| Assignment | A member's access to one twin (`TwinAssignment.userId`) or role play (`RolePlayAssignment.memberId`). |
| Org's people | The org's members, from `orgPeople` in `web/lib/org-people.ts`. |

## Rules

1. **Account first.** Adding an email to an org creates its account when none exists (lower-cased email, name from
   the part before `@`). No account is ever created by anything else except sign-in itself.
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
   shared twin link) calls `addPeopleToOrg`. Session start never creates a member; it refuses someone who isn't one.
7. **Roles.** One admin per org: adding a second admin is refused. Adding someone already in the org keeps their role
   (no role change through "add"). A learner assign (twin / role play) refuses admin and team people, who practise
   from the org's credits instead (see [Credits](credits.md)).
8. **Disabled stays disabled.** Adding or assigning a disabled member is refused with a message to re-enable them.
9. **Learner credits.** A new learner gets their starting credits when they're added (once per org, as today; see
   [Credits](credits.md)). Starting credits are all or nothing for a batch: when the org can't cover them, nobody is
   added.
10. **Sign-in is Google or an email code.** No passwords anywhere (no password sign-in, sign-up or reset). The code
    is 6 digits, valid 10 minutes, 3 tries, sent through Resend. The first sign-in with an email that has no account
    creates it (needed for shared twin links); signing in alone gives no org access.
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
    the action.

## Checks (must always hold; `web/scripts/check-org-people.ts`)

- Every member has an account; no account has two member rows in one org.
- Every twin assignment has `userId`, and that account is a member of the assignment's org.
- Every role-play assignment has `memberId`, and that member is in the assignment's org.
- Every learner credits row (`MinuteLedger` types `grant`, `usage`, `reclaim`) belongs to an email that is a member of
  that org.

Run in the test suites, in every release rehearsal, and after every release.
