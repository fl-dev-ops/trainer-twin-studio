# Role play on SKILL.md + items.json — plan (before / during / after)

**Status:** plan, 2026-10-27, decisions agreed. Base `v2`. Follows `roleplay-preservation.md` (nothing deleted, DB
changes only add, readers accept old shapes, `/api/v1` frozen, one feature per commit).

## 1. One shape for twin and role play: before, during, after

Every session module (twin skill, all-skills twin, role play) is configured in three independent parts. Each part has
one owner in the code, so changing one never touches the others.

| Phase | What it is | Twin (today) | Role play (new) | Owner |
|---|---|---|---|---|
| **Before** | what the learner brings before the call: file upload, screen share | `data.twinSettings` (upload offered / allowed, title, instruction, screen share, during-session attach) | same settings (today role plays fall back to "screen shared, documents accepted") | `lib/context-upload.ts`, pre-join, session start |
| **During** | what the AI is: **persona + skill** | own persona + SKILL.md / scenario.json / items.json (`kind TWIN`) | client persona + SKILL.md / scenario.json / items.json (`kind ROLEPLAY`) | `chat/` session module; web `getSessionContext` |
| **After** | what happens to the finished session: **report processing** | twin report (summary, topics, questions) via Vercel Workflow, `reportStatus` + quiet polling | role-play report (goals met / partly / missed, rubric points, pass, biggest opportunity) via the same Workflow | `lib/session-processing.ts` → workflow |

The AI only ever sees **During**. The rubric and the learner goals are **After**: the client never sees how the learner
is scored.

### Where each part lives in `Agent.data` (additive keys)

```jsonc
{
  "source": "scenario-ingest" | "twin" | "roleplay-skill",
  // During: the skill package (as twin skills store it today)
  "skill": "<SKILL.md>", "scenario": { /* scenario.json */ }, "artifacts": "<s3 prefix>",
  // Before: same fields as data.twinSettings, which stays readable as a fallback
  "before": { "preScreenshare": bool, "preUpload": bool, "duringUpload": bool, "uploadTitle": "…", "uploadInstruction": "…" },
  // After: how the finished session is processed
  "after": { "report": "twin" | "roleplay", "goals": ["…"], "rubric": [{ "name", "points" }] }
}
```

Persona (During) stays on the `Persona` row: prompt fields (`data`), voice, avatar, program settings.

## 2. During: the skill package for a role play

| File | Twin skill | Role play |
|---|---|---|
| `SKILL.md` | how the trainer runs this kind of session | the situation the AI plays: who it is on this call, situation, what is really going on (never volunteered), reactions (guarded if / opens up if), how the call can end, opening |
| `scenario.json` | name, description, roles, steps + moves | same; roles: `trainer_role` = the client's role (e.g. Buyer), `learner_role`; plus `difficulty` (drives the guard-level rules) |
| `items.json` | lines with `role: trainer \| learner` | lines with `role: client \| learner` — **roles depend on the kind** (schema per kind; Chroma filter and `scenario_examples` default role follow it) |

Stored exactly like a twin skill: files in S3 (`scenarioArtifactsPrefix`, versioned), items in the org's Chroma
collection, `kind = ROLEPLAY`, any persona of the org (Persona Library client, or the trainer's own).

### Old spec → new home

| Branch field (`config.scenario.roleplay` / builder) | Phase | New home |
|---|---|---|
| `persona` (client), `voiceId` | During | `Agent.personaId` → Persona row (its voice, photo, behaviours, mannerisms, phrases) |
| `client_name`, `how_they_talk` override | During | SKILL.md "Who you are on this call" (only when it differs from the persona) |
| `situation.scenario`, `hidden_truth` | During | SKILL.md `## Situation`, `## What is really going on` |
| `guarded_if` / `opens_up_if` | During | SKILL.md `## Reactions` |
| `agrees_when` / `declines_when` | During | SKILL.md `## How the call can end` |
| `opening` | During | SKILL.md `## Opening` (= first step) |
| `difficulty` | During | `scenario.json.difficulty` → fixed guard-level rules in the chat prompt |
| `learner_role` | During | `scenario.json.learner_role` |
| `what_to_expect` | Before (learner brief) | `scenario.json.description`, shown on the pre-join / invite |
| `learnerGoals` (≤5), `rubric` (≤8, 100 pts) | After | `data.after.goals`, `data.after.rubric` |
| `character_role` | — | dropped: the persona's behaviours say this |
| stages / evidence / interview config | — | dropped: `scenario.json.steps` = opening → objection → close, with client moves |
| — (new) | During | `items.json`: the builder's optional **Example lines** (may be empty); real lines later from recordings |

The two seed role plays (`wait-and-see-investor`, `options-collector`, branch `data/roleplay/seed.yaml`) are converted
once into `web/data/roleplay/skills/<slug>/builder.json` (the builder input; files are rendered from it) on the
closest v2 presets: wait-and-see → `off-plan-lead-waiting-for-prices`, options-collector → `overseas-investor-short-on-time`
(each keeps its own client name and situation).

## 3. Work, one commit each

1. ✅ **Before / after keys** — `data.before` (read `twinSettings` as fallback; writers write `before`) and `data.after`
   (`report: twin` for twins). No behaviour change; tests for both shapes.
2. ✅ **After: one processing path** — `processCompletedSession` dispatches on `data.after.report`; the role-play report
   moves onto the same Workflow + `reportStatus` + quiet polling as twin; scorer = the branch's role-play prompt
   (goals → rubric consistency, pass, biggest opportunity), goals and rubric from `data.after`. Legacy interview
   reports keep `scheduleSessionReport`. Port the branch's report tests.
3. ✅ **During: format** — `web/lib/roleplay-skill.ts`: `renderRoleplaySkill(builder)` → `{ skill, scenario, items }`
   + `after`, deterministic (no LLM); `roleplayBuilderFrom(data)` reads it back for editing; items schema per kind.
   Convert the 2 seeds. Tests: stable render, round trip, goals ≤ 5, rubric = 100.
4. ✅ **During: storage** — generalise `ingestScenario` to `kind ROLEPLAY` (any org persona; a twin and a role play never
   overwrite each other); same S3 + Chroma + SpecVersion flow; seed import script. Contract tests for both kinds.
5. ✅ **During: runtime (`chat/`)** — role-play module: `kind ROLEPLAY` + `data.skill` → `formatRoleplaySession`
   = the branch's fixed client rules (stay in character, guard levels by difficulty, speech only) + PERSONA block +
   `<roleplay>` SKILL.md + steps. Tools: `end_call` (ported), `scenario_examples` (role `client`); trainer tools
   hidden. Port `chat/tests/agent/lib/roleplay.test.ts`, adapted.
6. ✅ **Pages (/twin style)** — Scenarios list + overview; builder in three sections **Before / During / After**
   (create / edit → step 4); role-play sessions; session report; role-play users; sidebar ("Role play sessions",
   "Roleplay users").
7. **Later** — builder assistant, org type, copilot `save_roleplay_draft`, role plays ingested from real role-play
   recordings (scenario-ingest writes the same files).

Access stays `Deployment` → `RolePlayAssignment` (one attempt, 30 days).

## 4. Not touched

- The 10 global interview agents keep the old spec, the interview runtime and their report. Readers tell them apart by
  `typeof data.skill === "string"` (During) and a missing `data.after` (After falls back to today's routing).
- `/api/v1`: scenarios list both shapes with the same fields.

## 5. Decisions (agreed 2026-10-27)

| # | Decision |
|---|---|
| D1 | The trainer edits the **builder**; SKILL.md + items.json + after are regenerated on save. Recording-ingested role plays (later) show SKILL.md read-only. |
| D2 | `items.json` roles **depend on the kind**: twin `trainer \| learner`, role play `client \| learner`. |
| D3 | First client lines: optional **Example lines** in the builder (empty allowed); seeds carry a few. |
| D4 | Interview agents stay on the old spec. |
| D5 | Rubric and goals are **After** only; the AI never sees them. |
