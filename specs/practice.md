# Practice: who may talk to a twin, and what happens before, during and after the call

> **A rule spec.** It says how practising a twin *must* work; the code follows it, and a difference is a bug in the
> code. Module specs ([Twins](twins.md), [Sessions](sessions.md), [Learner portal](learner-portal.md),
> [Credits](credits.md)) describe the code and list differences under *Mismatches*. People, roles and sign-in rules
> are in [People](people.md); its Refusals (`signed_out`, `no_org`, `member_disabled`, `not_found`, `person_disabled`,
> `person_is_studio`) are used here too. Role plays get their own section when that module is done.
> Drafted 12 Nov 2026.

## Who uses it

| Actor | What they do here |
| --- | --- |
| Learner (`user`) | Opens their twin page (`/t/…`) or a link (`/s/…`), starts a call, talks, ends it. Uses their own credits. |
| Admin / team (studio) | Assigns twins, makes common links, previews and calibrates any live twin of their org. Uses the org's credits on a billed org; free otherwise. |
| Voice agent / chat brain | Runs the call with the session's runtime token; ends it at the deadline. |

## Words used here

| Term | Meaning (code name) |
| --- | --- |
| Live twin | A twin (`Agent.kind = TWIN`) of this org that isn't archived. |
| Usable assignment | The learner's `TwinAssignment` for that twin with status `active` and `accessUntil` empty or in the future. |
| Common link | A `TwinShareLink` code at `/s/<code>`; opening it while signed in adds an existing account to the org (People rule 6). |
| Call | A practice `InterviewSession`: `activating` → `active` → ended (`completed`, `abandoned`, `failed`, `revoked`). "Live" means activating or active. |
| Allowance | The seconds a call may last (`allowedSeconds`): the learner's balance at start (learners), or the org's (studio on a billed org). |
| Practice check | The one function that decides whether this person may start a call on this twin now, with the refusal when not. |

## Rules

1. **One practice check, everywhere.** The twin page, the link page and Start all use the same practice check, in
   the same order, and show the same refusal; studio previews too. A page never offers Start for a call that Start
   would refuse; it shows the refusal's message instead. Order: signed in → enabled member of this org (`no_org`,
   `member_disabled`) → live twin (`not_found`) → access (rule 2) → org not paused (`org_paused`) → credits (rule 4).
   Signed out, `/t/` shows the sign-in prompt and `/s/` sends to sign-in; only Start answers `signed_out`. Start runs
   the check again inside its transaction (rule 5).
2. **Access.** A learner may practise a twin only with a usable assignment (`twin_not_assigned`,
   `twin_access_revoked`, `twin_access_ended`). Admin and team may practise any live twin of their org without one.
   An archived twin can't be practised by anyone (`not_found`, on `/t/` and `/s/` alike). Revoked or ended access,
   like a paused org, stops the next start only: a call already live keeps going (disabling is the exception, rule 7).
3. **Common links join only on the link page.** Opening an active common link while signed in adds an existing
   account to the org as a learner with that twin (People rule 6; starting credits once). A disabled link refuses
   (`twin_link_disabled`). Start never adds anyone: starting with a link code needs a usable assignment already
   (`twin_not_assigned` otherwise, never a 500). A link of another org answers `not_found` (it doesn't confirm the
   code exists).
4. **Credits.** A learner needs at least `MIN_START_MINUTES` (5) of their own credits to start (`credits_out` under 1
   minute, `credits_short` for 1–4). Admin/team on a billed org need 5 of the org's credits (`org_credits_out`,
   `org_credits_short`); unbilled orgs are free. While live, a billed studio call holds its whole allowance (other
   starts see it as spent), so two trainers can't both spend the same credits. A paused org starts nothing
   (`org_paused`, Billing's pause messages), and its running calls continue.
5. **One live call per person.** Start takes the org's credits lock (`minutes:<org>`), re-runs the practice check
   counting the person's other live calls as ended now, and only then ends (and charges) those calls and creates the
   new one, all in one transaction with no network calls; LiveKit and the chat brain are set up after it commits. A
   refused start ends nothing. Two starts at the same moment run one after the other. This holds for studio members
   too: a second preview of the same twin ends the first through the normal end (rule 8), never by quietly marking it
   abandoned. If setting up the new call then fails, it is `failed` and uncharged; the call it replaced stays ended.
   Twin calls don't resume: every start is a new call (the agent's short LiveKit reconnect is not a resume).
6. **Twin calls are voice only** (`voice_only`).
7. **During the call** the voice agent ends it at the allowance (the deadline). Every 5 minutes the platform ends, as
   `abandoned`, any call still live 2 minutes after its deadline (agent crashed, tab closed), charging it up to its
   allowance and voiding its runtime token; a call with no allowance (a free studio call) after 3 hours; a call stuck
   starting (`activating`) after 10 minutes. A disabled member's live calls are ended at once (People rule 18),
   including one created a moment before the disable.
8. **Ending** goes through one path for every caller (page, agent webhook, deadline watchdog, disable, a newer
   start): the first end wins, and the call's usage row is written in the same transaction that ends it (one row per
   call; reporting it to Meteroid follows after commit). Its end work (room closed, report) then runs in the end
   workflow and is retried. The report uses the agent's transcript; a page ending the call never skips it.
9. **Runtime token** works only while its call is live; after that it is refused (`runtime_token_invalid`). With it
   the agent may report the call's status and recording; the page ends a call only through its owner's finalize,
   which can't set the recording. A recording upload is at most 200 MB.
10. **Assigning** a twin adds the people (People rules 6–9) and writes their assignments in the same locked
    transaction, all or nothing; a disabled person or a team member is refused (`person_disabled`,
    `person_is_studio`). Restoring a revoked assignment is refused the same way. Assigning someone who already has
    the twin keeps their assignment (re-activates a revoked one only when asked).
11. **Every refusal is ours** (People rule 23): code, status and message from the table below, the same wherever it
    is checked; anything not described here is refused.

## Checks (must always hold)

- No live call is more than 10 minutes past its limit (rule 7: deadline + 2 minutes, 3 hours without an allowance, 10
  minutes starting).
- No person has two live calls in one org.
- Every ended call that spent seconds has exactly one usage row; `failed` and `revoked` calls have none.
- Assignments: see [People Checks](people.md#checks-must-always-hold-webscriptscheck-org-peoplets).

## Refusals

Same columns as [People](people.md#refusals). **Where**: PG page loader (`/t/`, `/s/`), ST Start (`POST /api/sessions`
→ activation), RT runtime token routes, S service. People's `signed_out` (ST), `no_org`, `member_disabled` and
`not_found` (unknown, archived or other-org twin or link) are used at PG and ST.

| Code | Status | Message | When | Where |
| --- | --- | --- | --- | --- |
| `twin_not_assigned` | 403 | This twin isn't assigned to you. Ask your trainer for access. | Learner without an assignment for a live twin | PG, ST |
| `twin_access_revoked` | 403 | Your access to this twin was removed. Ask your trainer if you need it again. | Assignment revoked | PG, ST |
| `twin_access_ended` | 403 | Your access to this twin has ended. Ask your trainer if you need more time. | `accessUntil` passed | PG, ST |
| `twin_link_disabled` | 403 | This link is no longer active. Ask your trainer for a new one. | Common link disabled | PG, ST |
| `org_paused` | 403 | Billing's pause message (learner or studio wording, `lib/billing/paused.ts`) | Org paused (Billing rule 16) | PG, ST |
| `credits_out` | 403 | You've used all your practice minutes. Ask your trainer for more. | Learner balance under 1 minute | PG, ST |
| `credits_short` | 403 | You need at least 5 minutes to start a call; you have {n}. Ask your trainer for more. | Learner balance 1–4 minutes | PG, ST |
| `org_credits_out` | 403 | Your organization has no credits left. Contact TrainerTwin to add more. | Studio on a billed org, org balance under 1 minute | PG, ST |
| `org_credits_short` | 403 | Your organization needs at least 5 credits to start a call; it has {n}. Contact TrainerTwin to add more. | Studio on a billed org, 1–4 minutes | PG, ST |
| `voice_only` | 400 | Twin calls are voice only. | A twin call in another mode | ST |
| `recording_too_big` | 413 | A recording can be at most 200 MB. | Agent recording upload over 200 MB | RT |
| `runtime_token_invalid` | 401 | This call is no longer available. | Runtime token missing, wrong, or its call has ended | RT |

## Open questions

- **Joining by opening a link.** Opening an active common link while signed in adds you to its org (People rule 6),
  so a link someone else sends you can add you too. The org that made the link pays the starting credits. Keep, or
  require a "Join" button (a small page change)?
