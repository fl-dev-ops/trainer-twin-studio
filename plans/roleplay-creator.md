# Role-play creator: writing a good role-play skill from requirements

Status: design, 20 November 2026. Branch `feat/shared-skills`.

A role play is **one SKILL.md plus items** (lines the AI can pull from the vector index when it needs them), played
by **one persona** (a voice plus a light personality). The goal of this work is the quality of the writing: what the
session is about, who the AI and the learner are, what the AI has to do, and how. Scoring and reports are a separate
module, later. Several personas per role play, modes and variants are later, one at a time.

## What the industry does (research, Nov 2026)

| Source | What it separates | Notable guidance |
| --- | --- | --- |
| [Synthesia roleplay scenes](https://help.synthesia.io/en/articles/15901222-how-do-i-configure-my-roleplay-and-feedback-scenes) | Persona *background* (who they are before this situation) vs *Instructions* (the situation now; learner never sees it) vs objections vs skills | "What is happening right now belongs in Instructions, not Background." Instructions: what prompted the conversation, what the persona knows and doesn't know, how they feel at the start, conditional behaviour. Objections: 3–5, "Write the objections, not the answers." Who opens the call; 5–7 min practice. |
| [Yoodli builder](https://support.yoodli.ai/en/articles/11565137-create-custom-roleplays-with-the-builder) | Description (learner) vs Context (AI only, "you" statements) vs Persona (reusable: voice, tone, demeanor) vs Goals | "The more information and context you give the AI, the more accurate your members' experience will be." Personas are reused across roleplays with different contexts. |
| [Yoodli Roleplay Agent](https://support.yoodli.ai/en/articles/15960287-create-roleplays-with-roleplay-agent) | Conversational authoring | Waits for "the learner's role, the situation, and the desired difficulty"; drafts title, description, context, personas, objections; refine by chat ("make the CFO more skeptical"); "Save & preview". |
| [Exec Scenario Agent](https://www.exec.com/news/scenario-agent) | Character, situation, conversation guidelines, evaluation | "You describe the call. The agent handles the structure." Backstory explains behaviour; guidelines control how the character responds as the rep digs deeper; Try Now, then change by chat. |
| [Retorio briefs](https://www.retorio.com/blog/training-scripts-ai-role-plays-examples) | ROLE · SITUATION (what they want, hidden problem) · HOW YOU BEHAVE (how they open, what escalates/calms, what earns concessions) · WHAT ENDS THE CONVERSATION | One complete brief per scenario. |
| [Adobe Virtual Coach](https://experienceleague.adobe.com/en/docs/learning-manager/using/authors/virtual-coach/role-play-design) | Conversation context · persona background · persona concerns · openers · topics | "Most personas should have three to five concerns" — each with when it comes up and what resolves it; outcomes over topics; tension and competing priorities; "simulate a real conversation rather than a checklist of questions". |
| [eLearning Industry](https://elearningindustry.com/how-to-design-an-ai-roleplay-scenario-that-builds-real-skills) | Situation, learner goal, persona, traits, hidden background | Hidden background: private view of the problem, a past experience, a constraint, a condition for cooperation, an emotional register that shifts with the learner's approach. Resistance "reasonable and firm rather than hostile"; raise difficulty with stakes, not rudeness. |
| [Hyperbound](https://support.hyperbound.ai/articles/2228003008-building-bots) | Company · scenario · pain points · objections | A brain dump is analysed into the bot; "final configuration is similar to your input but not verbatim". |
| [OpenAI realtime prompting](https://developers.openai.com/cookbook/examples/realtime_prompting_guide), [ElevenLabs](https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide) | Voice-agent prompt: Role & objective · Personality & tone · Context · Rules · Conversation flow · Guardrails | Short bullets; numbered flow states with transitions; sample phrases are followed closely, so add a variety rule; tone stated once; no conflicting rules. |

The common pattern:

1. **Persona ≠ situation.** The persona is who someone is (voice, personality, how they usually talk) and is reused.
   The role play says what is happening now and what this person wants and does in it.
2. **The AI's instructions are a brief written to "you"**: your role here, the situation, what you want, your concerns
   (hidden until earned), how you react, how it starts, how it flows, what ends it.
3. **The learner brief is separate** and short: who they are, the situation, the outcome to aim for.
4. **Concerns and objections are written as the persona would say them, never with the answers.**
5. **Authoring is conversational**: describe → a few follow-up questions → draft → try it → change by chat.

## Part 1 — what a role-play skill contains

### Persona (Persona Library, unchanged storage)

Voice plus personality: name, role, a short personality ("calm, direct, hard to read"), how they usually talk. The
role play never redefines the personality; it sets only how they feel *in this situation* (e.g. guarded today).

### SKILL.md (the AI's brief, written to "you")

| Section | Holds | From the research |
| --- | --- | --- |
| `# <title>` + one line | What this practice is | — |
| `## Your role` | Who you are in this situation and your relationship to the learner (the persona gives your voice and personality) | Role & objective; ROLE |
| `## The learner` | Who they play and what they are trying to achieve | Learner role, outcome |
| `## Situation` | What triggered this conversation, what you know and don't know, how you feel at the start, facts to keep consistent | Instructions (now), Context |
| `## What you want and your concerns` | Your aim in the conversation; 1–5 concerns, each with when it comes up and what resolves it; which stay hidden until earned | Concerns, hidden background |
| `## How it starts` | Who speaks first; your opening line | Who opens |
| `## How the conversation goes` | 2–6 numbered steps (`### Name \`id\``): what happens and when to move on; moments you bring in on purpose | Conversation flow states |
| `## How you react` | What makes you open up; what makes you pull back; reasonable, firm resistance | HOW YOU BEHAVE, emotional register |
| `## How it ends` | Time or count limit; how it can end (good, partial, poor); your exit line | WHAT ENDS THE CONVERSATION |
| `## Rules` | Stay in role; never coach or evaluate; keep facts consistent; answer what is asked; vary your wording | Guardrails, variety rule |

Optional `## Using your lines` when items exist (which kinds to pull and when). The learner brief lives in
`scenario.json.description`, shown before the call. Goals for scoring are not in the skill.

### Items (`items.json` → vector index)

Lines the AI may pull: `example` (how you sound), `objection`, `question`, `concern`; each with `context` (when it fits)
and optional `step` and `tags` (e.g. investor). Origin: `authored` (written by the trainer), `session` or `doc`. The
AI uses them for substance and shape, varies the wording, and never invents new "trainer" lines.

### Example (Olga, scenario 1, one buyer) — abbreviated

```md
# First call after the ad
The agent calls back an enquiry; you are the buyer who submitted the form.

## Your role
You are Ravi Menon, a banker in Oman who clicked an Instagram ad about passive income from Dubai property.

## The learner
A Dubai real estate agent calling you for the first time. They are trying to understand what you really need and
agree a specific next step with a day and time.

## Situation
- You half-remember the form; other agents may have called you already.
- Budget AED 1.5–2.0M via mortgage; timeline 3–6 months; your wife is part of any decision.
- You feel neutral and a little busy at the start.

## What you want and your concerns
- You want simple, honest information that fits your goal, without pressure.
- Surface: "Just send me some options." Underneath: you are new to Dubai and risk-averse, and you need the mortgage
  steps explained simply. Reveal this only when the agent asks a genuine question about your situation and listens.

## How it starts
You answer the phone: "Hello, yes, Ravi speaking."

## How the conversation goes
### 1. Opening `opening`
Let the agent introduce themselves and the reason for the call.
### 2. Pushback `pushback`
Within your first answer, push back with your surface concern.
### 3. Commission test `commission-test`
Around the middle, whatever happens, say: "You just want the commission."
### 4. Next step `next-step`
If trust is high, share your budget range, timeline and who decides, and be open to a next step.

## How you react
- Open up when the agent asks about your purpose and family and explains affordability simply.
- Pull back at guaranteed returns, pressure on timelines, hard selling or buzzwords; each pitch before a question
  makes your answers shorter.

## How it ends
- At most 4 minutes.
- Good: you agree a follow-up call with a day and time. Partial: options on WhatsApp, no time set. Poor: no next step.
- After two pitches with no question, or a defensive answer to the commission test: "I've got to go, just send me
  something on WhatsApp."

## Rules
- Stay in role; never coach or comment on the agent's technique.
- Answer briefly; ask a question only occasionally.
- Keep your budget, areas and figures consistent.
```

Items for this role play: the shared pushback lines for investors, the secondary objection ("I want to wait and see"),
and Olga's other objections tagged by buyer type.

## Part 2 — requirements → skill (copilot)

1. **Route**: role play / practice / mock interview vs twin skill; ask once if unclear.
2. **Read** the trainer's message and attached documents; fill a structured spec with the sections above, each value
   marked *said* (from the trainer) or *proposed*.
3. **Ask once**, only for missing essentials: who the AI plays, who the learner plays, the situation, and what the
   learner should achieve. Propose the rest (opening, steps, reactions, ending) for the trainer to change.
4. **Choose the persona** from the Persona Library (or ask the trainer to create one); never put personality in the
   skill.
5. **Say plainly what is not supported yet** (several personas or a persona picked per session, Practice/Mock modes,
   scoring) and what the role play does instead.
6. **Build** with `build_roleplay`: renders SKILL.md and items from the spec and checks them: every section present;
   roles distinct; concerns without answers; hidden concerns absent from the learner brief; 2–6 steps; an ending and
   exit line; items with text, kind and context; no real people's personal details. At most 3 builds.
7. **Show the draft, change by chat, publish** on approval through the shared publisher. Edits make a new version.

## Verification

- Fixtures from real requirements: Olga S1 and S2, a Flo or Bevan scenario, a Jameel interview (Mock), a Vasanth
  round. Each renders to a skill a reviewer can read as a complete brief; checks pass; publish is idempotent.
- Copilot evals: each requirement document in → expected sections, roles and items out; vague input → one question.
- Real conversations per fixture (3 turns) on the local stack, including item pulls, judged against the brief.
