# Twin — Content Inventory (v2, as of 2026-10-26)

Everything that defines, produces, stores, and runs a **twin ("Ask Olga")** today. Gathered from code
on `v2`. Use this as the ground truth when separating twin from roleplay across DB / backend / UI.

---

## 1. What a twin is

> A twin is an open conversation with a trainer's persona that can draw on every playbook (ingested
> scenario) of that persona. It advises on the learner's **real situation** (next move + exact words),
> not teaching and not role play. — `web/lib/twins.ts`

Composition = **person's voice** (persona voice via `voiceId`) + **AI avatar** (persona identity;
scenario/agent intro video pre-join; persona name/initials avatar in studio) + **skills** (one
SKILL.md playbook per ingested scenario; items.json retrievable from Chroma).

Stored as a normal `Agent` row: `data.source = "twin"`. Nothing is copied — playbooks are the
persona's ingested scenario agents, found live at session start.

---

## 2. DB content

| Table | Rows / fields the twin depends on |
|---|---|
| `Agent` | twin row: `slug = "<org>-<persona>-twin"`, `name = "<persona>'s twin"`, `personaId`, `domainSlug = "domain-<slug>"`, `data.source="twin"`, `data.objective`, `data.config.context` (mode none), `version` |
| `Domain` | one per twin, placeholder data `{ id, name }` |
| `Persona` | the twin's identity + voice + style (uses `personaVoice` episodes in Chroma `persona_<personaId>`) |
| `Agent` (scenario rows) | the twin's **playbooks**: `data.source="scenario-ingest"`, `data.skill` (SKILL.md verbatim), `data.scenario` (scenario.json manifest), `data.artifacts` (S3 prefix) |
| `SpecVersion` | version snapshots of scenario agents (re-ingest Same as a dashboard publish) |
| `InterviewSession` | twin sessions (same table), context snapshot pins persona/agent/domain versions; `twinPlaybooks` are resolved **live**, NOT pinned |
| `Voice` | twin's speaking voice (persona's or org default) |
| `RolePlayAssignment` / deployments / share codes | **not twin-specific today** — twin is reached via `/dash/talk` (inner use) |

Where each scenario's run files live:

- **S3** `{basePrefix}/{orgId}/scenario-ingest/scenarios/{agentSlug}/v{version}/`
  - `SKILL.md`, `scenario.json`, `items.json`, `patterns.md` (per re-ingest, new version dir; carried forward: `introVideo`)
  - run archive: `{basePrefix}/{orgId}/scenario-ingest/runs/{runId}/` → `plan.json`, `report.md`, `specs/<id>.md`
- **Postgres**: `Agent.data.skill` + `.scenario` + `.artifacts` (pointer)
- **Chroma**: org's main collection, items indexed as `scenario_item` records under Chroma ids `scenario_item_{agentSlug}#{positionInFile}`

---

## 3. The twin's skills — file formats

### SKILL.md
YAML header (`---` …) containing scenario id + step ids/moves, then Markdown body with these exact
headings (`copilot/agent/lib/ingest.ts SKILL_SECTIONS`):

`## Goal`, `## Roles`, `## How a session runs`, `## Steps`, `## Rules`, `## Style`, `## Playing the learner side`

Body structure:
- Under `## Steps`: each step is a `### … \`<step id>\`` heading; each move has exactly one
  definition line `- \`<move>\`: what it does` (short; lumps get rejected). Low-evidence moves are
  marked `(low evidence)` inline; SKILL.md mirrors what's in the scenario.json YAML header.
- Rules are evidence-scoped: each carries a `(k of N sessions)` count copied from patterns.md or
  `(method docs)`. Absolute rules need repeated evidence.

### scenario.json (manifest)
```jsonc
{ scenario: "<kebab-id>", name, description (≤1024), trainer_role, learner_role,
  steps: [ { id, name, trainer_moves: string[], learner_moves: string[] } ] (1–30) }
```
+ optional non-validating keys (e.g. `low_evidence` per step).

### items.json (entries ≤ 5000 per scenario)
```jsonc
{ id, role: "trainer"|"learner", context (≤2000), text (≤8000),
  metadata: { step?, move?, source?, kind?, ref?: number|null, words? } }
```
Two formats tolerated by retrieval: `metadata.step`/`move`, and `metadata.action` (+`part`) with the
step derived from scenario.json (`scenarioId` = manifest.scenario).

### patterns.md
Reviewer evidence (counts, style, gaps). Archived to S3, validated against SKILL.md counts; never
shown to learners. Sections listed in `PATTERN_SECTIONS` (Session flow, Opening, Questions,
Follow-ups, Reactions to answers, Moving on, Closing, Learner side, Style, From the method docs, Gaps).

**Curation quality is enforced at ingest** (checks in `copilot/agent/lib/ingest.ts`): ≥3 sessions
per scenario, moves with ≥N supporting items per role × step, no personal-name leaks, counts must be
copied from patterns.md, redaction before publish.

---

## 4. Ingest and publish pipeline (where twin content comes from)

1. **copilot agent** (`copilot/`) — eve agent: `build-scenario` skill reads trainer recordings
   (`users/<user>/` in `INGEST_S3_BUCKET` or `INGEST_USERS` locally), drafts `specs/<id>.md`, plans
   the run, then builds via `build_scenario` tool (≤3 attempts: rejected items / check reasons).
   Verified by `check.ts` (counts, moves, leaks). `publish` → `publication.ts` snapshot-check +
   `studio-publish.ts` POSTs to web.
2. **web ingest API**
   - `POST /api/internal/scenarios` (Bearer `SCENARIO_INGEST_SECRET` + `x-trainertwin-org-id`)
     → `ingestScenario()` → S3 files first, then Chroma items, then Postgres rows (in that order so
     a failure never publishes partial content). Re-sending unchanged = no-op; changed = new version
     (snapshot + replace items). Slug ownership cross-org protected.
   - `POST /api/internal/scenario-runs` → `ingestScenarioRun()` archives plan/report/specs to S3.
   - Persona matched case-insensitively (copilot sends its source folder name, e.g. "vasanth").
3. **Idempotency/versioning**: content is compared with sorted-key JSON; `introVideo` carried forward
   across versions; scenario version = S3 folder version = Agent version.

---

## 5. Twin creation

- `POST /api/twins { personaSlug }` → `ensureTwin()` — idempotent; creates the Agent + placeholder
  Domain if absent (transaction; same-version checks as scenario ingest). This is the only twin-creation
  surface today; **no UI currently calls it** (it was consumed in prototype flows).

---

## 6. Twin at runtime (chat brain + web)

### Session resolution
- `web/lib/session-context.ts` → `buildSessionContext()`: `isTwin = agent.data.source'twin'` →
  `twinPlaybooks = twinPlaybooks(orgId, liveAgent.personaId)` (live; new ingests show up mid-life).
  Cached per session (`unstable_cache` 24h) so skills and prompt catalog agree for a session.
- `chat/agent/lib/brain.ts`: `isTwinData()`; twin sessions get **core-only base instructions**
  (see below) + `formatTwinSession()`.

### The two prompt artifacts
1. **Base instructions** — full `prompts/base-instructions.md` (interview flow, ~7,400 words) vs
   core-only extraction of five headings via `Chat` (Authority & Evidence, Operating Mode & Voice
   Rules, Audio & Spoken-First Rules, Visual & Screen Perception Constraints, Identity & Name Lock
   Rules, Same-Turn Continuation).
2. **`formatTwinSession()`** — the TWIN block (implementation exactly as written today):
   - You are \${who}'s twin; learner brings a real situation → **next move + exact words**; not a
     lesson, not a role play.
   - Speak as \${who}, first person, never invent facts about \${who}'s life/clients/results.
   - One short clarifying question if a missing detail would change advice; otherwise advise straight
     away. Never "have you tried…"; tell them what to try.
   - No frameworks/techniques recital; playbooks are judgment, loaded on demand via `eve__skill`
     (skill names from `playbookSkillNames()`, ≤64 chars, sanitized from let's say \${scenarioId}).
   - `scenario_examples({ playbook?, situation })` for real phrasing — tone/length/shape only, never
     word-for-word, never reuse past learners' details.
   - Never call `search_knowledge` (ground only in playbooks + examples); never `session_plan`; no
     agenda/quota/evidence grading.
   - [OPENING] turn: one short greeting + "what's going on with their client right now", no tool calls.
   - Closing: confirm-then-`finish_session` two-turn protocol.
   - **Playbook catalog block**:YOUR PLAYBOOKS list (skill name: name) — so the model can decide
     which to load; eve announces each skill with its description.

### Eve skills (the "twin-agent" surface to the model)
`chat/agent/skills/playbooks.ts` — on `session.started`: for twin sessions, registers ONE eve skill
per playbook; description = name + ": " + description + " Load before advising on a real situation of
this kind."; markdown = the SKILL.md verbatim. Non-twin sessions get none.

### Retrieval during sessions
- `chat/agent/tools/scenario_examples.ts` → studio `searchScenarioItems(orgId, agentSlug, ...)`;
  the scenario agentSlug comes **from session auth** (model cannot search past scenarios).
- `web/app/api/copilot/studio/route.ts`:
  - twin → searches **all of the persona's playbooks** (`twinPlaybooks` slugs) or a named one
    (unknown names widen to all, so sanitized skill names still succeed);
  - regular scenario-ingest agent → only its own scenario.
- Chat-side dispatch: `main-collection.ts` `searchScenarioItems()` — Chroma ANN over `scenario_item`
  metadata: type/orgId/agentSlug**(s)**/scenarioId/itemId/itemIndex/role/context + metadata scalars
  (step/move/action/side/kind/ref/words); optional `step` filter resolved via `scenarioStepIndex()`
  (step → [step id ∪ its moves ∪ actions ok]); fallback to whole scenario if the step has no lines.

---

## 7. Twin's avatar & voice mechanics

- **Voice**: `session-activation.ts` reads `agent.data.voiceId`, else persona-ish/org shared default;
  validated against `Voice` rows (status ready, org-scoped). Persona voice moments in
  Chroma `persona_<personaId>` are what make the twin *talk like* the person (`search_style`) +
  via the twin's use of `personaVoice` in sessions; the twin prompt bans `search_knowledge` but leaves
  `search_style` usage stated in the persona block ("Recorded style and decision preferences…").
- **Avatar/video**: `Agent.data.introVideo` (S3 key or URL) is the pre-join intro (“Twin card” UI
  uses `UserAvatar` with the persona	name; scenario cards use `personaQuote(agent.persona.data)` for
  a real line). Intro download client-cached (`intro-video-cache.ts`); opening speech held until
  video ready (agent python coordination on "begin-opening").

---

## 8. Twin today vs what the roleplay branch / docs call "Twin QnA"

Current twin has: playbooks (SKILL.md per ingested scenario) + epoch of \${items in Chroma} +
persona voice/style. It does **not** have (per `plans/spec_twin-qna.md`): its own knowledge KB toggle,
course-material per-use-case KB (`qna-<slug>`), allow screen-share/upload, calibrations
(like/off + reasons), flagged replies, `IssueReport` links, scenario overview of questions asked.

---

## 9. What separation must preserve / decide (the actual file map)

| Concern | File(s) touched today by the twin kind | Notes |
|---|---|---|
| kind marker | `data.source` string | replace with real kind column/field |
| creation | `web/lib/twins.ts`, `app/api/twins/route.ts` | keep as the twin lifecycle |
| session resolution | `lib/session-context.ts:135`, `chat/agent/lib/brain.ts:75` | live playbooks lookup |
| prompt | `chat/agent/lib/base-instructions.ts`, `prompts/base-instructions.md`, `brain.ts formatTwinSession` | core-only mode |
| skills | `chat/agent/skills/playbooks.ts` | 1 skill per playbook, model loads on demand |
| retrieval | `app/api/copilot/studio/route.ts` (searchScenarioItems), `lib/main-collection.ts` | twin-wide scavenging vs scenario-scoped |
| ingest (content) | `lib/scenario-ingest.ts`, `app/api/internal/scenarios|scenario-runs`, copilot `publication/studio-publish` | unchanged by the split |
| S3/Chroma | `lib/s3.ts` (scenarioArtifactsPrefix/runPrefix), `main-collection.ts` (replaceScenarioItems) | layout can stay |
| versioning | `SpecVersion` snapshots on re-ingest | unchanged |
| voice | `session-activation.ts` (voiceId lookup) | twin uses persona voice; keep as people-moveable |
| avatar/video | `introVideo` carried on re-ingest, pre-join via `specs.listScenarioIntroVideos` | keep |

Risk to note: `twinPlaybooks` are live-joined (not pinned) during a session, while persona/agent/domain
versions ARE pinned. If separation tightens kind at activation, decide whether a session's playbook
list is pinned too.
