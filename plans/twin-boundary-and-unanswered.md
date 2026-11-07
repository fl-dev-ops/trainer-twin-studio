# Twin boundary ("ask the real <name>") and "Couldn't answer" tracking

Status: built 6 Nov (steps 1–3, committed locally); step 4 (regenerate old reports) optional at deploy.

## Why

- The twin's only boundary today (chat/agent/lib/brain.ts, formatTwinSession) is: "If no playbook covers the situation,
  say so plainly and give only advice you are sure of." That still lets it answer from general model knowledge.
- Prod, Olga's twin (playbooks: objection handling): Cathy asked "can you help me with cold calling?" and it answered
  "Yes, of course. Cold calling is all about disarming the client in the first twenty seconds…" with no playbook loaded;
  another reply over-claimed "I am here to help you win deals across real estate sales…".
- Nothing records what the twin couldn't answer. The twin report (web/lib/twin/session-report.ts) has summary, topics,
  questions only; "Most asked" counts `questions`.

## What we build

### 1. The boundary (chat, the twin prompt)
In `formatTwinSession` (chat/agent/lib/brain.ts), replace the soft line with:
- Stay inside your playbooks. When the learner asks for advice none of them covers (another part of the job, another
  topic, legal / tax / financial questions, anything personal about <name>), do not advise from general knowledge.
  Say exactly: **"I can't answer this question, please ask the real <name>."** Then offer help with what your
  playbooks do cover, in one short line.
- Small talk, greetings and follow-ups on advice already given are not declines.
- When asked what you can help with, name only your playbooks' topics (no over-claiming).
- No playbooks at all: every request for advice gets the same line.
- `<name>` = the persona's first name (Olga's: "Olga").
- Decide from the playbook catalog already in the prompt: no extra tool call, no added latency.
- Tests: chat/tests/agent/lib/twin.test.ts — the prompt contains the exact line with the persona name, and the "no
  playbooks" case uses it.

### 2. Recording it (web, the after-call twin report)
In web/lib/twin/session-report.ts, one more field, extracted by the same model call:
- `unanswered`: the learner's questions the twin declined (it said it can't answer / to ask the real trainer), rewritten
  as short standalone questions, max 5. [] when none.
- Prompt + JSON schema + `modelOutput` + `TwinReport` (optional in the stored shape, so older reports still parse:
  missing = []).
- No new table, no tool: the decline line is in the transcript the report already reads.
- Tests: tests/lib/twin-session-report.test.ts — toTwinReport keeps / trims / caps `unanswered`; an old report without
  it still passes isTwinReport.

### 3. Showing it (web, studio)
- Twin page (components/twin/twin-agent-detail-page.tsx): a **"Couldn't answer"** card next to "Most asked", counted
  the same way (`mostAsked` over each session's `unanswered`, lib/twin/trpc.ts `agents.get`). Main twin: all its
  sessions, as today. Empty: "Nothing yet."
- Session page (components/twin/twin-session-detail-page.tsx): the session's `unanswered` list under its topics.
- Sessions list: no change (keeps the row short).

### 4. Existing sessions (optional)
- Reports made before this have no `unanswered`. A one-off script can regenerate the twin reports of the last N days
  (same workflow) so the card isn't empty at the start. Olga's prod: a handful of sessions. Decide at deploy.

## Not in this plan (later)
- Per-twin wording or a "Never advise on" list in Configure (default line for every twin for now).
- The copilot suggesting a new skill from "Couldn't answer" questions.
- Role plays (they have their own client prompt; the boundary is a twin thing).

## Order and checks
1. Chat prompt + tests → live check on the local stack: ask Olga's twin about cold calling (expect the exact line) and
   about an objection (expect normal advice with a playbook loaded).
2. Report field + tests → run the report on that local session: `unanswered` holds the cold-calling question.
3. Twin page card + session page → browser check.
4. Deploy: chat and web together (web first: no migration). Optionally regenerate recent reports (step 4).
