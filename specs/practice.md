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
   A personal link (`/s/` with an assignment code) belongs to its learner: anyone else, studio members included, is
   refused (`twin_not_assigned`); studio members use the twin page or a common link.
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
   A call that a newer start ended while it was still being set up never becomes live (`call_replaced`).
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

## Calibration (admin and team testing a twin)

12. **A calibration is a studio call marked at Start.** Start with `calibrate: true` (admin/team, a live twin of
    their org) creates the call and its calibration record in the same transaction; the practice check (rules 1–6)
    applies as for any studio call, and the calibrate page shows its refusal instead of Start. A learner asking for a
    calibration is refused (`studio_only`); there is no separate "mark this call" step.
13. **Rating** a reply ("Good" / "Feels off") belongs to the calibration's creator and works only while its call is
    live (`calibration_ended` after). Someone else's calibration, another org's or a deleted call's answers
    `not_found`. The turn number is a whole number from 0 and the reply text at most 8,000 characters
    (`invalid_input`). Rating the same turn again replaces its rating.
14. **Scoring** runs once in the call's end workflow, after the agent's final transcript (or its wait) and with the
    ratings saved by then: it calls the scoring model once per calibration, saves the result, and is retried by the
    workflow when the model fails. A scored calibration isn't scored again. Until it is scored, pages show the raw
    counts.
15. **Viewing** a calibration (list or review) is for the org's admin and team; an archived twin's or a deleted
    call's calibration answers `not_found`. Lists show at most the 100 newest.
16. **"Feels off"** means the same thing everywhere: one rule in `web/lib/twin/stats.ts` (case-insensitive,
    punctuation ignored, "feel off" too), matched by the chat brain's own copy (a test checks they agree).

## Role plays

17. **A learner practises a role play only through their own link** (`/s/<code>` of a `RolePlayAssignment`). The link
    page and Start run the same check (rule 1) in the same order: signed in → enabled member (`no_org`,
    `member_disabled`) → the link is theirs (`roleplay_not_assigned`; the page shows its switch-account screen
    instead) → the link is open, `pending` or `used` (`roleplay_access_removed` once cancelled or expired) → the role
    play is live (`not_found`) → the mode is allowed (`mode_not_allowed`; learners only call by voice) → org not
    paused → credits (rule 4). Another org's or an unknown code is `not_found`. Admin and team start a role play by
    name only (`studio_only` for learners); nothing else starts one. Hiding role plays (`hideRoleplay`) only hides the
    studio's navigation: links keep working.
18. **Role-play calls resume.** Starting again on a link whose call is still live returns that call (same deadline),
    decided inside Start's lock and only while it is still live (never bringing back an ended call); that call is
    not ended as "another live call". A second tab joins it: the first tab, pushed out by the same person joining,
    doesn't end it. Joining failing never fails the call it joined.
19. **Assigning** a role play adds the people (People rules 6–9) and writes their assignments in the same locked
    transaction, all or nothing (as rule 10), from the dashboard, the copilot and the REST API alike: a disabled or
    team person refuses the whole batch (`person_disabled`, `person_is_studio`). Someone who already has an open
    link keeps it. The API's move of a link to another learner or role play cancels the old link and creates a new
    one (`assignment_exists` when the target already has one). Practice is counted from calls; a link's status is
    `pending` until cancelled (no `used` step), and disabling someone cancels their open links.
20. **Saving a role play** (builder, settings, draft publish, spec upload) runs one at a time per role play
    (`agent:<slug>` lock, held across its files and examples): the version only moves when the content changes, its
    files and examples belong to that version, and settings saves never move the version or bring back an older
    script (a settings save of an archived role play is `not_found`; publishing it again from the builder or the
    copilot brings it back). Draft publish and spec upload refuse builder role plays
    and twins (`invalid_input`); they are for older spec-built role plays only.
21. **A role play's id is its org's.** Generating or importing one whose id belongs to another org is refused
    (`name_taken`), and one that is a twin (`invalid_input`), before any model is called.

## Checks (must always hold)

- No live call is more than 10 minutes past its limit (rule 7: deadline + 2 minutes, 3 hours without an allowance, 10
  minutes starting).
- No person has two live calls in one org.
- Every ended call that spent seconds has exactly one usage row; `failed` and `revoked` calls have none.
- Every calibration belongs to a twin call of its creator. Every calibration created under rule 12 (from 15 Nov 2026)
  whose call ended (`completed` or `abandoned`) more than an hour ago is scored; older ones may stay unscored.
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
| `calibration_ended` | 409 | This calibration call has ended. | Rating after the call ended | T (`calibrations.rate`) |
| `call_replaced` | 409 | This call was replaced by one you started elsewhere. | A newer start ended this call while it was being set up | ST |
| `voice_only` | 400 | Twin calls are voice only. | A twin call in another mode | ST |
| `recording_too_big` | 413 | A recording can be at most 200 MB. | Agent recording upload over 200 MB | RT |
| `roleplay_not_assigned` | 403 | This role play isn't assigned to you. | A link of another account (studio members included) | PG, ST |
| `roleplay_access_removed` | 403 | Your access to this role play was removed. Ask your trainer. | Link cancelled or expired | PG, ST |
| `mode_not_allowed` | 400 | This role play can't be started as {mode}. | Mode outside the deployment's allowed modes, or a learner not calling by voice | ST |
| `assignment_exists` | 409 | That learner already has this role play. | REST API moving a link to someone who has one | R |
| `name_taken` | 409 | That name is used by another organization. Pick another. | A role play's id belongs to another org | S |
| `runtime_token_invalid` | 401 | This call is no longer available. | Runtime token missing, wrong, or its call has ended | RT |

## Open questions

- **Joining by opening a link.** Opening an active common link while signed in adds you to its org (People rule 6),
  so a link someone else sends you can add you too. The org that made the link pays the starting credits. Keep, or
  require a "Join" button (a small page change)?
