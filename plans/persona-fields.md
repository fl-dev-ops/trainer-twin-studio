# Persona: every field and what each option means

Source: `origin/feat/client-roleplay-mode` (`web/lib/client-persona.ts`, `chat/agent/lib/roleplay.ts`).
Knowledge is out of scope: a persona has none; only the role play has a knowledge base.

## Two kinds of persona (flag already on v2)

`Persona.isOwn` (migration `split_twin_roleplay`):

| `isOwn` | What it is | Built from | Used by |
|---|---|---|---|
| `true` | The user's own persona (the trainer, e.g. Olga) | Recordings → analysis → synthesis (`PersonaSourcePanel`) | Twins (required by a DB trigger) |
| `false` | Every other persona: clients a learner speaks with, global interviewers | The persona form (presets fill it) | Role plays |

No new column is needed. The branch's `data.kind: "client"` becomes redundant with `isOwn = false`.

## Fields of a (client) persona

| Field | Stored as | Options | Goes to |
|---|---|---|---|
| Look | `look` | daniel, rajesh, claire, elena, marcus | Picks the avatar photo; fills the form from a preset |
| Avatar | `avatar` | photo path (`/roleplay/avatars/*.jpg`) | UI only (cards, call screen) |
| Name | `name` | free text | Prompt: "You are {name}" |
| Role | `role` | 8 options, below | Prompt: "Role on this call" |
| Age | `age` | free text / number | Prompt |
| Based in | `based_in` | free text | Prompt |
| Background | `background` | free text, ≤ 2000 | Prompt |
| Behaviours | `behaviours[]` | 5 options, up to 3 | Prompt |
| Difficulty | `difficulty` | easy, medium, hard, hardest | ⚠ saved but **not used**: the prompt uses the role play's difficulty |
| Opening style | `opening_style` | friendly, skeptical, rushed | Prompt |
| Formality | `mannerisms.formality` | casual, neutral, formal | Prompt |
| Answer length | `mannerisms.answer_length` | short, medium, long | Prompt |
| Interrupts | `mannerisms.interrupts` | never, sometimes, often | Prompt |
| Pauses | `mannerisms.pauses` | on / off | Prompt |
| Fillers | `mannerisms.fillers` | on / off | Prompt |
| Signature phrases | `signature_phrases[]` | up to 4 lines | Prompt |
| How they talk | `how_they_talk` | free text | Prompt (the role play's own wording wins) |
| Voice | `voiceId` | a ready voice (sample or cloned) | Voice agent TTS, not the prompt |
| Pace | `pace` | slow, normal, fast | ⚠ only a prompt line; not applied to TTS speed |

Today the prompt sends most options as bare labels ("Formality: casual."), so the model guesses what they mean. The sentences below are meant to replace those labels.

## What each option means (prompt-ready)

### Role (who they are on the call)
- **Buyer:** You want to buy a property to live in, for yourself or your family.
- **Seller:** You own a property and are thinking about selling it.
- **Landlord:** You own rental property. You care about rent, tenants and empty months.
- **Investor:** You buy property for returns. You think in yield, capital growth, risk and exit.
- **Prospect:** You have not decided you need anything yet. The agent has to give you a reason to keep talking.
- **Decision maker:** You have the final say and little time. You care about outcomes, cost and risk, not details.
- **Customer:** You already work with this agency. You expect them to know your history.
- **Champion:** You like the idea, but others must agree. You need the agent to arm you with reasons to convince them.

> ⚠ Decision maker, Customer and Champion are B2B sales terms and fit real estate poorly.

### Behaviours (pick up to 3)
- **Warm & Open:** Friendly and easy to talk to, but you still will not buy on this call.
- **Warm but Cautious:** Polite and pleasant, yet careful. You hold back anything personal until trust is earned.
- **Curious & Probing:** You ask the agent pointed questions and want to understand before you share.
- **Skeptical & Reserved:** You doubt what agents say, give little away and need proof before you engage.
- **Direct & Challenging:** Blunt and brief. You push back hard and test whether the agent knows their stuff.

(Already written in the branch as `CHARACTER_ROLES`, but used only for the role play's character, not the persona's behaviours.)

### Difficulty (how hard the client is to win)
- **Easy:** Nervous but willing. One calm, good question lowers your guard. You forgive a small mistake. Start at guard level 2.
- **Medium:** Guarded at first. You open up only when the agent earns it with calm, specific questions. Start at guard level 3.
- **Hard:** Confident and testing. You get impatient with weak, generic or scripted questions. Start at guard level 3.
- **Hardest:** You hide the real issue behind a surface objection and reveal it only to a careful, specific question. After two mistakes you end the call. Start at guard level 4.

### Opening style (how they answer the call)
- **Friendly:** You answer warmly and are happy enough to take the call.
- **Skeptical:** You answer guarded and want to know who is calling and why before you give any time.
- **Rushed:** You are busy. You say you have little time and want the point quickly.

### Formality (how polished their language is)
- **Casual:** Relaxed, everyday language. Contractions, first names, the odd informal word. No business phrasing.
- **Neutral:** Polite, plain conversational language. Neither chatty nor stiff.
- **Formal:** Polished and businesslike. Complete sentences, courteous phrasing, no slang. You keep a professional distance.

### Answer length (how much they say at a time)
- **Short:** A few words or one sentence. You make the agent ask follow-up questions.
- **Medium:** One or two sentences. You answer the question with a little context.
- **Long:** Two to four sentences. You share context and small stories, and sometimes drift.

> ⚠ "Long" conflicts with the base speaking rule (one to three sentences).

### Interrupts (how often they cut the agent off)
- **Never:** You always let the agent finish.
- **Sometimes:** You cut in now and then, when the agent rambles or repeats a pitch.
- **Often:** You cut in regularly, impatient with long or scripted explanations.

> ⚠ In voice the model cannot truly talk over the agent; it can only open its reply with an interruption ("Sorry, let me stop you there").

### Pauses and fillers
- **Pauses on:** Sometimes you take a beat before answering, like a real call ("Hmm… let me think").
- **Fillers on:** Now and then you say "um", "well" or "you know".

### Pace (how fast they speak)
- **Slow:** Unhurried. Few words, deliberate.
- **Normal:** Ordinary conversational speed.
- **Fast:** Quick and clipped. You move on fast.

> ⚠ Pace should set the TTS speaking rate in the voice agent. Today it is only a prompt line.

## The user's own persona (isOwn = true)

A different shape, built from recordings rather than the form: `name`, `style`, `examples`, `decision_preferences`, `disclosure`, `source_resources`. In the v2 DB, Olga's own persona has only `id` and `name` so far. It surfaces in Twin's brain (Training style, Voice and avatar).

## Open points

1. **Difficulty:** should the persona own it, the role play, or the persona as a default that the role play can override?
2. **Role list:** keep the three B2B roles, or replace them with real-estate ones (e.g. Tenant, Developer)?
3. **Long answers vs. the 1–3 sentence rule:** which wins?
4. **Pace:** wire it to the TTS speed in the voice agent?
