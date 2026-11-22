# Persona research and proposed boundaries

Researched 19 November 2026. Research/proposal only: no application, database, storage or runtime changes.
Voice is a reusable, non-versioned resource referenced by Persona. Persona versioning remains undecided.

## Main finding

A reusable persona answers **who this person is and how they behave**.
A roleplay supplies **what is happening, what this person wants in that situation, and what the learner is practicing**.
A session records **what has actually happened during this attempt**.

Vendors do not all draw these boundaries identically. Their public documentation describes product behavior
and authoring fields, not their private database schemas. Tavus is a conversational-agent infrastructure
reference, not a directly equivalent training product; its PAL bundles more than our Persona should.

## Official sources and findings

### Yoodli — reusable personas with separate roleplay context and goals

- [Roleplay builder](https://support.yoodli.ai/en/articles/11565137-how-to-build-and-customize-roleplays):
  roleplay context defines the situation, timing and goals. Personas define name, voice, tone, demeanor,
  avatar, optional background and behavior. The same persona can be used across roleplays with different
  contexts. Learner success is configured through separate goals.
- [Persona generation](https://support.yoodli.ai/en/articles/18419351-personas-create-with-ai):
  explicit editable fields are name, job title, company, demeanor, background, persona behavior, avatar
  and voice. Supporting documents can inform authoring, and generated personas are reviewed before saving.
- [Global personas](https://support.yoodli.ai/en/articles/18420527-global-personas):
  one organization-level persona can be referenced by multiple roleplays without duplication. Editing
  affects every attached roleplay, including the next reply of an active session. This feature explicitly
  has no version history. Historical sessions retain the persona's name, title and demeanor from that time.
  Deletion is blocked while enabled roleplays use the persona.
- Implication: reuse by reference is a documented pattern. Live propagation is a product choice,
  not a requirement we should copy.

### Hyperbound — detailed buyer profiles, with persona and scenario information combined

- [Build your first bot](https://support.hyperbound.ai/articles/2721037683-how-to-build-your-first-bot):
  authoring includes job title, call scenario, company, product description, buyer situation, pain points
  and objections. Generated sections include personal details/emotional state and priorities/objections.
  A separate scorecard is selected. Draft and publish are separate actions.
- [Bot-building best practices](https://support.hyperbound.ai/articles/2228003008-building-bots):
  recommends company, scenario, pain points and objections. The AI builder interprets this input;
  its generated configuration is not necessarily verbatim.
- Implication: personality alone is insufficient for a convincing counterpart. It needs priorities,
  reasons for resisting and conditions for changing its position. However, current budget, competitor,
  product and deal objections should not automatically become permanent reusable-persona facts.
- Caution: Hyperbound's Kind/easy to Rude/hard emotional-state control is its product approach.
  We should not equate difficult practice with rudeness.

### VirtualSpeech — character, situation and measurement are explicit separate authoring concerns

- [Custom roleplays](https://virtualspeech.com/platform/custom-roleplays):
  separates the situation/learner brief and constraints, character, scoring criteria, and rollout.
  Character configuration includes position, what the character knows, what they concede and how hard
  they push. Scenario scoring is separately authored.
- Implication: a character needs knowledge boundaries and believable concessions, not merely a
  tone label. Learner scoring is not the character's identity.

### Tavus — structured behavior plus separate presentation and conversation data

- [Prompting guide](https://docs.tavus.io/sections/onboarding-guide/prompting-guide.md):
  recommends identity/role, personality/style, core behavior, response rules and guardrails.
  Behavior should be concrete: example phrasing and situation-response rules, rather than
  unsupported adjectives such as "professional." Conversation-specific data goes into conversation context.
- [PAL strategies](https://docs.tavus.io/sections/onboarding-guide/pal-strategies.md):
  explicitly distinguishes different per-session data from different behavior. Shared PAL patches can
  affect current conversations; isolated per-session configuration is another supported approach.
- [Voices](https://docs.tavus.io/sections/conversational-video-interface/voices.md):
  a voice is created once and referenced by ID by any number of PALs and Faces.
- Implication: our voice-reference decision has a direct documented analogue. We should adopt
  separation of reusable definition and session context, not copy PAL's full tools/model/flow configuration
  into our Persona.

## Proposed persona responsibility

1. Maintain a consistent identity and conversational style.
2. React credibly to what the learner says: clarify, resist, reconsider or concede for understandable reasons.
3. Apply stable preferences without changing the roleplay's facts or inventing authority.
4. Stay within the character's knowledge and role; do not reveal hidden training instructions.
5. Use the selected voice/avatar without treating them as behavioral instructions.

The persona is not automatically a coach. A simulated buyer should not switch into coaching or tell the
learner how to earn rubric points. A coach persona may coach when the selected agent/experience requires it.

## Suggested contents

| Area | Reusable persona content |
| --- | --- |
| Identity | Name, short description, professional role/expertise and relevant background |
| Disposition | Stable traits such as direct, patient, analytical or skeptical, described behaviorally |
| Conversational style | Formality, typical answer length, phrasing, clarification habits, characteristic expressions |
| Decision preferences | What kind of explanation/evidence they value; how they respond to uncertainty or pressure |
| Presentation | `voiceId` and optional avatar reference; no copies of voice files |
| Provenance/ownership | Organization, fictional versus real-person basis, source references and permission evidence where relevant |

Do not require every optional detail. Start with a small structured definition plus free-text guidance.
Avoid demographic fields unless relevant to the learning objective; age, nationality or gender must not
be used as substitutes for behavior or ability.

## Keep outside the reusable persona

| Information | Owner |
| --- | --- |
| Today's budget, company/deal facts, complaint or negotiation position | Roleplay-specific character context |
| Starting mood or urgency for this exercise | Roleplay configuration |
| Learner objective, stages, question quotas, difficulty, success criteria | Agent/skill/roleplay |
| Domain documents and approved answers | Knowledge/skill resources, with access scoped to the role |
| Tool availability and execution permissions | Agent/runtime policy |
| Learner resume, previous answers, trust/rapport, current mood, concessions already made | Session state |
| Scores, transcript evidence and coaching report | Evaluation/reporting |

A persona may have stable domain expertise and characteristic concerns, but that is not unrestricted
access to every organization document or to the learner's hidden answer key.
Persona-specific preferences are subordinate to scenario facts, runtime permissions and platform safety.

## Example: reuse Vasanth without mixing the interview into his identity

- **Persona:** Vasanth's identity, speaking style, characteristic phrasing and verified behavioral preferences.
- **Resume-defense roleplay:** interviewer assignment, claim-verification objective, resume policy and probing limits.
- **Conceptual-understanding roleplay:** selected topics, question mix, follow-ups and evidence criteria.
- **Session:** the learner's attached resume, selected question, previous answers and collected evidence.

The roleplays can use the same Vasanth persona without copying its definition or putting their question
plans into it.

For a fictional buyer, stable skepticism belongs to the persona; "has a 20,000 budget and needs to move
this month" belongs to that buyer's roleplay context. Initial frustration is not the same as a permanent
personality trait, and the session can evolve after effective listening or credible evidence.

## Fit with our existing implementation

- `web/lib/persona.ts` already distinguishes character identity/style from scenario/skill actions.
  Its `personaBrief` explicitly assigns HOW to Persona and WHAT to scenario/skill.
- Existing roleplay-persona fields cover identity, background, behavioral traits, opening style,
  mannerisms, phrases and free-text speaking guidance.
- Our trainer/self path currently uses identity only in that brief and relies on ingested skills for
  behavior. Real trainer data can also have legacy style/preferences/source-evidence shapes.
  A single new form must not silently overwrite these shapes or duplicate skill-owned behavior.
- The existing `Persona.voiceId` uniqueness and voice-copy selection behavior differ from the agreed
  reusable-voice design. This research does not change either.

## Planning recommendation

1. Agree the persona/roleplay/session boundary before designing new fields.
2. Support fictional characters and real trainer personas, preserving source-derived data and consent.
   Do not generate unsupported personal facts to fill gaps in a real trainer's profile.
3. Keep Voice non-versioned and referenced; do not introduce persona version tables solely for symmetry.
4. Preserve the resolved persona configuration at session start so edits do not change an active test.
   Session snapshots are a separate decision from library version history or publish/rollback tooling.
5. Show which agents use a persona before editing it; block or archive instead of deleting in-use records.
6. Test persona behavior separately from learner scoring: consistent identity, appropriate resistance and
   concessions, no rubric/answer leakage, and no contamination between learners or roleplays.

No schema or migration is approved by this research note. Full persona versioning, a draft/publish workflow,
and the exact permitted roleplay-level overrides remain product decisions rather than implementation assumptions.
