# Port /agents into role plays, then remove /agents

Goal: one kind of role play. Every legacy interview agent is converted **in place** (same row, same slug) into a skill
role play with every setting carried over; then the /agents pages and finally the legacy interview runtime are removed.

In place keeps what hangs off the agent row: learner assignments, `/s/<code>` share links, past sessions and their
reports. The old agent data is kept in `data.legacy` (with its version) for rollback only; it is never shown or run.

## Decisions (2026-11-21)

- One version per role play, in place. No side-by-side copies after the port is verified.
- Calibration stays (moves to `/roleplay/[slug]/calibrate`). Fidelity is removed.
- Résumé claims: no special claim tool. Any role play can take a document before or during the call (Settings tab,
  with a new "required" switch); the AI reads it with `read_document`, and the skill says how to use it (quote only
  what it says, surface contradictions). This works for any role play, not only interviews.
- Old version history is not carried over; the converted role play starts at skill v1 with `portedFrom`.

## Phase 1: the ported skill does everything the interview did (done 2026-11-21)

1. Question bank → role-play items (`kind: question`, topic/difficulty/type tags), looked up with `scenario_examples`;
   the skill tells the AI to state the problem first.
2. Settings tab: "required" switch for the before-call upload.
3. Stage evidence (★ required) → the role play's rubric, so reports score the same things.
4. Knowledge bases stay attached and searchable.
5. Intro video, voice, follow-up cap, turn limit work on the role-play runtime and are editable.
6. Authored role plays: opening line and learner brief editable on the simple edit page.
7. System-design: whiteboard step (done); screen share off unless set (done).

Exit: old vs ported session for each of Vasanth's 10 on latencytest judged equal or better.

## Phase 2: convert in place (done locally 2026-11-21; production pending)

`scripts/port-interviews.ts`: dry run by default; `--apply` converts each legacy interview under its own slug (the
publish snapshots the old data as a SpecVersion), and `--rollback` restores it. Local → staging copy → production (run by the owner, not the agent).

## Phase 3: remove /agents (done 2026-11-21)

Redirects (`/agents/*` → `/roleplay/*`, `lib/agents-redirect.ts`), fix every link, delete `app/dash/agents/**`, agent editor,
role-play preview, fidelity, their tRPC procedures and tests. Calibration moves under `/roleplay`.

## Phase 4: retire the legacy interview runtime (separate PR)

Once production has no legacy interviews: chat stage/phase path, `session_plan`, `roleplay-interview` mode,
`lib/runtime/*`, live question-bank selection, `resume-claims`.
