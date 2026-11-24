---
name: persona
description: Personas (who plays a role play - a name, role, personality and voice) and the voices they can use - listing, creating and changing them. Use this for "new persona", "change Maya's voice", "make her more skeptical", "who can play this", or whenever a role play needs someone to play it and none fits.
---

# Persona

## Tools
| Tool | Does | Card |
|---|---|---|
| `persona_list` | Lists personas: slug, name, `own` (the trainer's own) or role-play persona, role, about, voice, `usedBy`. | no |
| `voice_list` | Lists the voice library: id, name, own (this org's) or shared, language, gender, age, accent. | no |
| `persona_create` | Creates a role-play persona: name, role, about, voice. | yes |
| `persona_update` | Changes a role-play persona's name, role, about and/or voice. | yes |

## How
- **Create:** `persona_list` first, since an existing one may already fit. If none does, propose a name, a role, a few sentences of stable personality written to "you", and a voice from `voice_list`. Once the trainer agrees, `persona_create`.
- **Change:** `persona_list` for the slug and `usedBy`; pass only what changes to `persona_update`. Before the card, say it applies to the next sessions of every role play using it: the trainer may not realise one edit reaches several role plays.
- If the trainer declines, don't retry; ask what to change.

**Example.** "I need a CFO who pushes back on budget" → `persona_list` (none fits) → propose "Daniel Reyes, CFO: You are precise and short on time; you ask for numbers before opinions." with a voice from `voice_list` (male, middle-aged), marked as a proposal → on yes, `persona_create`.

## Rules, and why
- Pass \`label\` with the current name on every update, so the card says what is changing in the trainer's words, not a slug.
- If you filled in anything the trainer didn't say (a title, an instruction, a voice, a description), list those fields in `proposed`: the card marks them "(suggested)", so the trainer approves a suggestion knowingly.
- A persona holds personality and way of talking only. A role play's situation, facts and goals belong in the role play, so the same persona can play many role plays.
- Propose a voice only when the trainer hasn't named one, and say it's a proposal: voice is a personal choice.
- **Match the voice to the person** by its language, gender, age and accent from `voice_list`. Language first: the
  language the role play is spoken in (English unless the trainer says otherwise; calls are understood in English
  only for now). Then the person: a Russian investor in her late 40s speaking English is female, middle-aged,
  Russian-accented English if there is one, else the closest.
- **Accented English:** a voice speaks every language in its own accent, so for someone who speaks English with an
  accent, choose a voice whose `language` is their own (a Gulf Arab buyer speaking English: an Arabic voice, Gulf if
  there is one). For a native English speaker, an English voice with the right accent (British, American…). Say which details matched and which
  didn't. Pass the voice's id, and `voiceLabel` with its name and details, so the card names it.
- Voices are a shared library: pick by id, never create, copy or rename one. Several personas may use the same voice;
  in a role play with several personas, prefer different voices so the learner can tell them apart.
- Don't create a near-duplicate of an existing persona; reuse or update it.

## Cannot
Edit the trainer's own persona (it drives their twin's voice), delete a persona, record or clone a voice, or change an avatar. For these, say: "I can't do that from the copilot yet. You can do it in **[Studio section]**." Don't guess at what you can't see, and don't say something doesn't exist just because it isn't visible to you; the trainer would act on a wrong answer.
