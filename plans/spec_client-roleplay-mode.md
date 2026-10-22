# Client Role-Play — Plan

**Branch:** `feat/client-roleplay-mode`
**Status:** approved; building
**UI reference:** prototype https://trainertwin-beta.vercel.app/ (sidebar "Role play" section)
**Dev database:** local Postgres 18 in Docker (`tt-pg`, `127.0.0.1:5433`), restored from a prod dump on 2026-10-21. `web/.env` points at it; the prod URL is kept in `web/.env.prod-db-backup`.

## 1. Goal

Today every session is a *trainer twin*: the AI is the interviewer and the learner is the
candidate. Client role-play adds a second product: the AI plays a **client** (an
investor, a landlord, a seller…), and the learner practises selling to them.

**Interviews must keep working exactly as they do now.** Every change is gated on
"is this a role-play scenario?". Interview code paths must not change behaviour.

First two scenarios (content in `/data/workspace/roleplay_personas.md`):

| Scenario | Client | Opening line |
|---|---|---|
| The wait-and-see investor | Daniel Hart | "The market has basically stopped. I'll wait for prices to hit the bottom, then I'll buy." |
| The options-collector who ghosts | Priya Shah | "Can you just send me some options?" |

The clients are invented characters, **not twins of a trainer**. No trainer recordings,
phrasing or knowledge may shape how they speak.

## 2. What the prototype asks for (field inventory)

### 2.1 Persona library (`Role play → Persona`)
Reusable client characters, grouped by **practice type** (Sales, Interview, Communication) and
**industry** (Real estate, Software & SaaS, Insurance). One persona per industry can be the **default**.

The persona form has four tabs.

**Persona tab**

| Field | Values |
|---|---|
| Starting template | Daniel, Rajesh, Claire, Elena, Marcus |
| Name | text |
| Role | Buyer, Seller, Landlord, Investor, Prospect, Decision maker, Customer, Champion |
| Age, Based in, Background | text |
| Behaviour (up to 3) | Warm & Open, Warm but Cautious, Curious & Probing, Skeptical & Reserved, Direct & Challenging |
| Difficulty | Easy, Medium, Hard, Hardest |
| Opening style | Friendly, Skeptical, Rushed |
| Formality | Casual, Neutral, Formal |
| Answer length | Short, Medium, Long |
| Interrupts | Never, Sometimes, Often |
| Pauses before answering | toggle |
| Uses fillers | toggle |
| Signature phrases | up to 4 |

**Other tabs**

| Tab | Fields |
|---|---|
| Avatar | portrait image |
| Voice | one voice from the library (female or male, or the trainer's cloned voice), plus speaking pace: Slow, Normal or Fast |
| Knowledge | uploads and connected sources the persona draws examples and objections from |

### 2.2 Scenario builder (`Role play → Scenarios → New`)

**Step 1, Situation:**

| Field | Notes |
|---|---|
| Scenario | Visible to the client prompt |
| What's really going on | Hidden; revealed only when the learner earns it |
| Learner role | e.g. "Agent calling a wait-and-see investor" |
| Learner goals | At most 5. **These are what the learner is scored on.** |
| How the call can end | "Agrees when" and "Declines when" |
| TeeTee assistant | Voice or text: "Tell TeeTee the scenario" |
| Generate from recent activity | AI action |

**Step 2, Role play agent:**
1. Choose who you'll speak with: a persona from the library.
2. Character role, recommended from your content.
3. Difficulty, with a one-line description.
4. How they talk.
5. How they react: two editable lists, "Gets more guarded or ends the call if the agent…" and "Opens up if the agent…".
6. Opening message, with a Generate button.
7. "What to expect", a brief for the learner.

A preview card on the right shows the avatar, the character role, "Role play with Daniel", a one-line
summary, and a **Try role play** button. Footer buttons: Back, Try Role play, Save role play.
Scenarios can be Draft or Published.

### 2.3 Scenario detail
Client persona, scenario summary, number of sessions, average score, a weekly chart, and the
list of conversations.

### 2.4 Role play sessions and report
A list of learner sessions (scenario, time, length, score). The report shows:
- overall score as a percentage, plus Pass or Fail
- the biggest opportunity
- what went well
- each **learner goal** marked Met, Partly or Not met
- the full call transcript

## 3. Database: what changes

**Recommendation: no schema migration.** Role-play reuses the existing tables. All new
fields live in the JSON `data` columns that already exist. The reason is that
`InterviewSession.agentId` is a required foreign key to `Agent`, and activation,
assignments, deployments, LiveKit dispatch and reports all key off `Agent`. A separate
scenario table would mean changing all of them, and that would put interviews at risk.

| Prototype concept | Stored as | New rows only |
|---|---|---|
| Client persona | `Persona` row, `data.kind = "client"` plus the client fields (§2.1) | Yes |
| Role-play scenario | `Agent` row; role-play fields under `data.config.scenario.roleplay` (free-form; allowed by the strict schema) | Yes |
| Learner goals | One stage's `config.evidence.definitions` (already read by reports as "Evaluation criteria") | Yes |
| Scenario voice | `Agent.data.voiceId` (already used at activation) | — |
| Avatar image | S3 key in `Persona.data.avatar` | — |
| Industry / practice type / default | `Persona.data.practice_type`, `industry`, `is_default` | — |
| Draft / Published | the existing spec versioning and publish flow | — |
| Role-play report | `InterviewSession.report` JSON with a role-play shape (goals met/partly/not, pass, opportunity) | — |
| Domain | one new `Domain` row: `real-estate-sales` | Yes |

### 3.1 Exact JSON shape for every prototype field

**Scenario** is an `Agent.data` (existing JSON column). Everything role-play specific lives under
`config.scenario.roleplay`. Learner goals are stored only once: as the stage's evidence definitions,
which the report already scores against.

```jsonc
{
  "id": "wait-and-see-investor",
  "name": "The wait-and-see investor",
  "domain": "real-estate-sales",
  "objective": "<one-line summary shown on the card>",
  "opening": "<opening message>",          // what the client says first
  "voiceId": "<voice id>",                  // copied from the persona's voice on save; the voice agent screen reads this as today
  "config": {
    "scenario": {
      "roleplay": {
        "version": 1,
        "persona": "daniel-whitfield",       // Persona slug picked in "Choose who you'll speak with"
        "client_name": "Daniel Hart",        // optional per-scenario name override
        "situation": {
          "scenario": "…",                   // Situation → Scenario
          "hidden_truth": "…",               // What's really going on
          "learner_role": "Agent calling a wait-and-see investor",
          "agrees_when": "…",                // How the call can end → Agrees when
          "declines_when": "…"               // How the call can end → Declines when
        },
        "agent": {
          "character_role": "Warm but Cautious",   // 2. Choose their character role
          "difficulty": "medium",                  // 3. easy | medium | hard | hardest
          "how_they_talk": "…",                    // 4. How they talk
          "reactions": {
            "guarded_if": ["Agrees with the fear or sounds worried too", "…"],   // 5. Gets more guarded or ends the call if the agent…
            "opens_up_if": ["Acknowledges the concern calmly without arguing", "…"] // 5. Opens up if the agent…
          },
          "what_to_expect": "…"                    // 7. What to expect (learner brief)
        }
      }
    }
    // other config keys keep the minimal values the compiler requires (see task 5)
  },
  "stages": [{
    "id": "call",
    "config": { "evidence": {
      "definitions": { "goal_1": "Acknowledge the concern calmly, without arguing", "goal_2": "…" },  // Learner goals (max 5)
      "keys": ["goal_1", "goal_2"], "completion_keys": ["goal_1", "goal_2"]
    } }
  }]
}
```

**Client persona** is a `Persona.data` (existing JSON column). These are the fields the scenario
builder needs from "Choose who you'll speak with". The persona library rows are seeded; no persona UI is built in this branch.

```jsonc
{
  "kind": "client",                      // separates client personas from trainer personas
  "name": "Daniel Whitfield", "role": "Buyer", "age": 44, "based_in": "London",
  "background": "Off-plan buyer, wants to wait for prices to drop",
  "behaviours": ["Warm but Cautious"],
  "opening_style": "skeptical",
  "mannerisms": { "formality": "neutral", "answer_length": "short", "interrupts": "never",
                  "pauses": true, "fillers": true },
  "signature_phrases": ["I'll wait and see.", "Maybe call me in three months."],
  "avatar": "<S3 key or static path>",
  "voiceId": "<voice id>",
  "practice_type": "sales", "industry": "real-estate", "is_default": true
}
```

Existing trainer personas, agents and sessions are untouched. Lists filter on
`data.kind` and `config.scenario.roleplay`, so the two products never mix.

**Data writes (local DB only):** 5 client Personas (the prototype library). Each role-play scenario gets its own
`domain-<slug>` domain when it is saved, as Twin scenarios already do, so no shared domain row is needed.
The Daniel and Priya scenarios are created through the new UI (or the import script). **You'll confirm before any write.**

If you'd rather have dedicated tables (`RolePlayScenario`, `ClientPersona`), that's a
migration plus changes to activation and sessions. I'll write it up separately if wanted.

## 4. Runtime (brain in `chat/`)

Production voice and chat both use the Eve brain (`LLM_BASE_URL`, `CHAT_URL`).

1. **Prompt layer.** `session-spec.ts` detects role-play and builds a trusted
   `CLIENT ROLE-PLAY MODE` system block from:
   - the scenario: situation, hidden truth, how the call can end;
   - the persona: identity, behaviour, speaking mannerisms, signature phrases;
   - difficulty, the two reaction lists, and the opening line.

   This block follows the structure of the tested prompts in `roleplay_personas.md`:
   a guard level that moves between 1 and 5, reveals tied to specific questions, and
   end conditions. For role-play, the interviewer sections of SESSION DATA are left out.
   A short clause at the top of `instructions.md` says the block replaces sections 1–5,
   except the spoken-output formatting rules.
2. **Tool layer, enforced in code.** For role-play sessions:
   - `search_style`, `search_knowledge`, `read_document`, the résumé tools and `session_plan` return "disabled";
   - workspace tools are refused;
   - `finish_session` is allowed without the two-step closing, so the client can hang up.

   The mode flag is kept in Eve session state.
3. **Opening.** On `[OPENING]` the client says the scenario's opening message.
4. **Interview sessions:** no change. Existing prompt-contract tests must pass unchanged, and new tests assert that interview grounding is byte-identical.

## 5. Reports

`generate-session-report.ts` branches on role-play:
- The prompt switches to "AI client and Learner (sales agent)". Only learner lines are scored.
- The output schema is `{ score, pass, biggestOpportunity, whatWentWell, goals: [{ goal, status: met | partly | not_met, evidence }], keyMoments }`, which matches §2.4.
- Interview reports keep their current schema and prompt.

## 6. UI (web/): Scenarios tab only

Decided 2026-10-21: **only the existing scenario configuration page (`/agents/[slug]/edit`) changes.**
The voice session screen, Sessions, Personas, Voices and Learners pages stay as they are, and
role-play runs in the existing voice session screen.

### 6.1 Role play / Twin switch
A segmented control **above all settings** on the scenario configuration page:

| Option | What the page shows | Saved as |
|---|---|---|
| **Twin** | Today's editor, unchanged: instructions, first message, trainer persona, knowledge base, interview type, follow-up cap, résumé main questions / technical topics and question counts, learner upload, voice | Today's flow: `POST /api/agents/[slug]/generate`, where the LLM builds the spec from the instructions |
| **Role play** | The new builder from the prototype (§2.2): **Situation** (scenario, what's really going on, learner role, learner goals ≤5, agrees when / declines when) and **Role play agent** (avatar cards for the client personas, character role, difficulty, how they talk, both reaction lists, opening message with Generate, what to expect), plus the preview card | New `POST /api/agents/[slug]/roleplay`. The spec is built **deterministically** from the fields (no LLM), then the same `saveSpecDraft` / `publishSpecDraft` path, so drafts, versions and publishing work the same |

- When an existing scenario opens, the switch is set from its data: `config.scenario.roleplay` present → Role play, otherwise Twin. Every existing Vasanth scenario opens as Twin and looks exactly as today.
- A new scenario defaults to Twin.
- Switching a saved scenario from one kind to the other asks for confirmation, because the other kind's fields are replaced when it's saved.
- Both kinds keep the existing header: History, Save draft, Publish.

### 6.2 Elsewhere
- Scenarios list: a small "Role play" badge on role-play scenarios. No other change.
- The existing Personas page hides `kind: "client"` rows (a query filter), so the trainer persona list is unchanged.

Deferred: TeeTee assistant, Generate from recent activity, Recommended character role, persona Knowledge,
a persona library UI, and a role-play-specific report screen (reports still render in the existing session view).
The opening-message Generate button is included.

## 7. Work breakdown

| # | Task | Files | Done when |
|---|---|---|---|
| 1 | Role-play types, detector, prompt builder | `chat/agent/lib/roleplay.ts`, `web/lib/roleplay.ts` | Unit tests: builder output for Daniel and Priya |
| 2 | Brain grounding switch + base-prompt clause | `chat/agent/lib/brain.ts`, `instructions/session-spec.ts`, `instructions.md` | Role-play block emitted; interview grounding unchanged (snapshot test) |
| 3 | Tool guards | `chat/agent/tools/*`, `lib/workspace-tools.ts` | All lookup and workspace tools no-op in role-play; tests |
| 4 | Role-play report | `web/lib/generate-session-report.ts`, `session-report.ts` | Role-play schema produced; interview report tests pass |
| 5 | Seed YAML + import script | `web/data/roleplay/**`, `web/scripts/import-roleplay.ts` | Rows compile through `buildSpecs`; script imports into a chosen org (**local DB only, after your OK**) |
| 6 | Hide client personas from the Personas page | personas list query | Trainer persona list unchanged |
| 7 | Role play / Twin switch + role-play builder on the configuration page | `components/agent-editor.tsx`, `components/roleplay-editor.tsx`, `app/api/agents/[slug]/roleplay/route.ts`, `lib/roleplay.ts` | Twin unchanged; role-play saves draft and publishes through the normal flow |
| 8 | Role-play badge in the Scenarios list | `components/spec-resource.tsx` | Badge shown only on role-play rows |
| 10 | End-to-end check | — | An interview session and both role-plays run in voice and chat against the local DB; reports render |

Order: 1 → 2 → 3 (brain), 5 (data), 4 (report), 6, then UI 7 → 8, then 10.

## 8. Risks

| Risk | Mitigation |
|---|---|
| The interviewer prompt pulls the client back into interviewer behaviour | Tool guards plus the trusted mode block. If drift persists, move the interviewer body into a dynamic instruction that is skipped for role-play. |
| A local web app still talks to **prod** S3, Chroma and LiveKit (only the DB is local) | Role-play doesn't write knowledge. Session recordings would go to the prod S3 prefix: I'll set a separate `S3_BASE_PREFIX` for local runs (an env change only, which you'll confirm). |
| `search_knowledge` hard-codes the `acme-knowledge` slug | Out of scope; disabled for role-play anyway. |
| The prototype shows "Daniel Whitfield" in the library and "Daniel Hart" in the scenario | The scenario can override the persona's display name. |

## 9. Decisions (2026-10-21)

1. Demo org: `latencytest` ("Demo").
2. No schema migration. Everything goes in the existing JSON `data` columns (§3.1).
3. AI helpers (TeeTee, generate-from-activity, recommended role, persona knowledge) are deferred.
4. Voice only, in the existing session screen. Only the Scenarios tab gets UI changes.
