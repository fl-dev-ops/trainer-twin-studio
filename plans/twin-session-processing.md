# Twin session processing

When a session completes, generate the report that fits its kind (twin or roleplay) and store it.
Roleplay report generation stays exactly as it is.

## Today

- Sessions reach `completed` in 3 places, and each one calls `scheduleSessionReport(id)`:
  `app/api/sessions/webhook/route.ts`, `app/api/sessions/finalize/route.ts`, `app/api/sessions/route.ts`.
- `scheduleSessionReport` claims the session (`reportStatus` → `generating`) and runs `generateSessionReport`
  in `after()`. That prompt is written for roleplays, and twin sessions get it too.

## Flow

```
session completed (webhook / finalize / sessions route)
  └─ processCompletedSession(id)                       lib/session-processing.ts  (new)
       ├─ load session: agent.kind, calibration?, transcript, agent name
       ├─ twin calibration → stop (not a learner session)
       ├─ claim: reportStatus none|failed → generating (no double runs)
       └─ after():
            ├─ kind TWIN → generateTwinReport(session)  lib/twin/session-report.ts  (new)
            └─ else      → generateSessionReport(id)    (existing, unchanged)
       └─ save report + reportStatus completed | failed
```

1. **Wait for completion.** Same trigger points as today: the 3 callers call `processCompletedSession(id)`
   instead of `scheduleSessionReport(id)`. The session is read fresh from the DB when the job runs, so it
   sees the final transcript. If the transcript wasn't there yet, the run is marked `failed`, and the webhook
   (which carries the transcript) claims it again, as the current code already allows.
2. **Pick the processor by kind.** One `if` on `agent.kind`. Roleplay goes to the existing
   `generateSessionReport`, untouched.
3. **Store.** The twin report goes into the existing `report` column with `reportStatus: "completed"`, so no
   migration is needed. Roleplay pages already skip anything that isn't a roleplay report (`isSessionReport`).

## Twin report

One instruction set for all twins for now. One LLM call, using the same gateway, model env and usage metering
as the roleplay report.

```json
{ "kind": "twin", "summary": "1-2 sentences", "topics": ["2-4"], "questions": ["learner questions, max 5"] }
```

- Input: the transcript as `Learner:` / `Twin:` lines and the twin's name.
- No learner line → store an empty report without an LLM call.
- Validated with `isTwinReport()`; an invalid model reply → `failed`.

## Twin pages

- `/twin/sessions/[id]` "Topics discussed" ← `report.topics` (instead of the roleplay `summaryTags`).
- `/twin/[id]` "Most asked" ← count identical `questions` across the twin's sessions, top 3.
  shortcut: exact-text match; group similar questions only if the counts come out fragmented.

## Steps

1. `lib/twin/session-report.ts`: prompt, JSON schema, `isTwinReport`, `generateTwinReport`.
2. `lib/session-processing.ts`: `processCompletedSession` (load, skip calibrations, claim, dispatch, save).
3. Switch the 3 callers.
4. Read `topics` / `mostAsked` in `lib/twin/trpc.ts`; render on the two twin pages.
5. Existing twin sessions: one-off loop calling `processCompletedSession` after resetting `reportStatus`.

## Checks

- Unit: `isTwinReport`, parsing a sample model reply, `mostAsked` counting.
- Locally finish one twin and one roleplay session: the twin stores `{ kind: "twin", … }`, the roleplay stores
  the usual report.
- `bunx tsc --noEmit` and the existing tests.

## Not now

Reports raised (no session-linked issue reports yet), avg response time (agent only logs latency), any
per-twin custom instructions.
