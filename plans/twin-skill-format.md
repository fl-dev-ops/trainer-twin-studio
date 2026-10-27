# Twin skills, not role plays: copilot rebuild (plan)

## The rule

A **twin skill** is the trainer's **knowledge, decisions, patterns and approach on one topic**, extracted from their material.
- The twin uses it to advise a learner on a real situation, the way the trainer would.
- **It is not a role play.** There is no learner part to play, no practice script and no trainer/learner moves.
- Role plays are built elsewhere (the role-play builder, `roleplay-skill`). Everything the copilot publishes is a twin skill.

## What is wrong today

The copilot was built as "scenario ingest" for role plays, and **the code enforces that shape**, so wording alone can't fix it.

| Where | Role-play assumption |
|---|---|
| `skills/build-scenario.md` | "Build one role-play scenario"; "the practice, the trainer part and the learner part" |
| Plan checks (`lib/ingest.ts`) | ≥3 **two-person** recordings; `trainer` and `learner` speaker labels; `plays`; "practice" spans with ≥5 turns **from each side** |
| Items | ≥30 trainer **and** ≥30 learner items; `role` trainer/learner; `part` |
| `scenario.json` / steps | `trainer_role`, `learner_role`, steps with `trainer_moves` **and** `learner_moves` |
| `SKILL.md` sections | Goal, Roles, How a session runs, Steps, Rules, Style, **Playing the learner side** |
| `patterns.md` sections | Session flow, Opening, Questions, Follow-ups, Reactions to answers, Moving on, Closing, **Learner side** |
| Chat twin prompt | Has to translate: "the playbooks are written as coaching sessions; turn what the coach would teach into…" |

Side effect: solo material (lessons, method docs, a talk to camera) can't count as a source, even though that is where most knowledge lives.

## The twin-skill format

**`SKILL.md`**: one topic, in the trainer's voice and judgment. Sections:
- `## Topic`: the situations this skill covers, and when it applies.
- `## What I know`: facts, market knowledge and principles the trainer states.
- `## How I decide`: decision rules, "when X, I do Y because Z", each with evidence counts.
- `## Patterns I see`: recurring client/learner situations, what they usually mean, and the trainer's read on them.
- `## My approach`: how the trainer handles this kind of situation, step by step (a way of working, not a script).
- `## What I say`: how the trainer phrases things (their lines and style), for the twin's voice.
- `## Gaps`: what the material doesn't cover (the twin says so instead of inventing).

**`skill.json`**: replaces `scenario.json`.

```json
{ "skill": "<id>", "name": "…", "description": "…",
  "situations": [{ "id": "<kebab>", "name": "…" }] }
```

The situations are what the twin's catalog lists and what examples are searched by. There are no roles and no moves.

**`items.json`**: **only the trainer's own words.** Each item is one passage where they explain, decide, read a situation or phrase something.

```json
{ "id", "source", "n"|"quote", "situation", "kind": "knowledge|decision|pattern|approach|phrasing",
  "context", "text" }
```

**`patterns.md`**: the evidence notes behind SKILL.md, with the same sections and `(k of N sources)` counts and `[[file#turn]]` refs.

**Sources:** any of the trainer's material counts: coaching sessions, solo lessons, method docs. In a two-person recording only the trainer's turns are used. Minimum: material from **≥3 sources**, plus item minimums per kind (to be set in code).

## Changes

1. **copilot:**
   - instructions ("Twin skill ingest", the rule above, verbatim);
   - skill `build-twin-skill`;
   - plan, item, SKILL.md and patterns checks plus the requirements text rewritten for the format;
   - `build_scenario` becomes `build_skill`;
   - publication sends `skill.json`;
   - README.
2. **web:**
   - `/api/internal/scenarios` accepts the twin-skill package (`skill.json`, trainer-only items) and stores it as a TWIN skill;
   - `twinPlaybook` reads the situations;
   - Chroma items keep `situation` and `kind`;
   - **old role-play-shaped skill twins stay readable** (nothing deleted).
3. **chat:**
   - the twin prompt drops the "written as coaching sessions" translation;
   - `scenario_examples` for twins searches by situation and kind;
   - a single skill twin advises on its topic (decision D1).
4. **Tests:** copilot checks; web contract (copilot publish → web store); chat prompt.

## Open decisions

| # | Question | Proposal |
|---|---|---|
| T1 | SKILL.md voice: first person ("I…") or about the trainer ("She…")? | **First person**: the twin speaks as the trainer |
| T2 | Can solo lessons and method docs be sources, alongside coaching sessions? | **Yes**: knowledge lives there too |
| T3 | Existing role-play-shaped skill twins (acme): keep readable, or delete and rebuild? | **Keep readable**; rebuild in the olga org with the new copilot |

## Status

**Built.** The copilot has two skills:
- `roleplay-creator`: today's role-play builder, publishing kind ROLEPLAY;
- `twin-creator`: `lib/twin-skill.ts`, the `build_twin_skill` and `publish_twin_skill` tools, and web `/api/internal/twin-skills`.

T1–T3 as proposed: first person; any of the trainer's material counts (sources of every kind); older role-play-shaped skill twins stay readable.

- **Storage:** `Agent.data.source = "twin-creator"`, with `skill.json` under `data.scenario` and situations as stages.
- **Items:** `role: trainer`, `metadata.step` = situation, `metadata.type` = kind.
- **Chat:** a single twin skill advises from its own topic (D1) via `twinSessionPlaybooks`, with no session plan.
- **Tests:** contract tests in `web/tests/lib/scenario-ingest-contract.test.ts`; chat tests in `chat/tests/agent/lib/twin.test.ts`.
