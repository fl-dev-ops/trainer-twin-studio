# Situational persona speech

Stop stamping `got it, got it` / `okay, got it` / `yeah, so` on every turn. Use those moves only when the last learner turn actually calls for them.

## Goal

Vasanth’s twin should sound like Vasanth **in this situation**, not like a loop of his most common fillers.

Likeness = when to acknowledge, when to correct, when to just ask. Not a filler quota.

## Diagnosis (bench `sample-1` / vasanth)

Turn shape in `bench/results/latest.json`:

```
Got it, got it. So you {paraphrase}. Now, {one poke}?
```

Almost every assistant turn. Filler rate **0.69**. Real Vasanth (743 interviewer turns): `got it, got it` is **1.2%**, mostly after long / messy answers. **77%** of his turns have none of those listed acks.

Root causes, in order:

1. **Hardcoded turn template** in `renderPersonaSpeech` (`web/lib/runtime/openai.ts`):
   `GOOD: … "got it, got it" / "correct?" / "good, good", restate … then one poke.`
   The model is obeying this, not the corpus.
2. **Rewrite sees interviewer lines only.** `interviewerLine()` strips situation. Hits already have `learnerState` / `move`; the prompt ignores them.
3. **Retrieval always queries `move: probe`**, so it prefers ack-then-poke moments even after a short clean answer.
4. **No recency guard.** Same opener can fire 9 turns in a row.
5. **Bench learner** (`bench/learner_persona.py`) lists `"Yeah, so…"` as required starters; DeepEval then copies the previous user tone.

Fact firewall stays: corpus candidate speech must not enter the rewrite. `persona-voice.test.ts` requires embed text omit candidate proper nouns (`Stripe`). Do not put other interviews’ candidate facts into the spoken prompt.

## Non-goals

- Filler classifier / extra LLM.
- New DeepEval metrics.
- Changing `selectAction` / interview law.
- Re-extracting the 22 transcripts.
- Reindex, unless Phase B is needed.

## Contract

| Layer | Source of truth |
|---|---|
| Whether to speak an ack | Current learner turn + last trainer opener |
| Which poke | Controller action (unchanged) |
| Wording | Retrieved moments, labeled by `learnerState`/`move`, plus YAML examples |
| Facts | Current transcript + content contract only |

Hard locks from `plans/persona-runtime.md` still apply.

---

## Phase A — no reindex (ship this)

Biggest win. Prompt + retrieval query + one validator. Existing Chroma blobs stay.

### A.1 Drop the template; label moments

**File:** `web/lib/runtime/openai.ts` (`renderPersonaSpeech`)

Delete the GOOD/BAD filler recipe.

Show each hit as a situation pair **without corpus candidate facts**:

```
[vague / probe]
Interviewer: How did you measure that?
```

Use `hit.learnerState` and `hit.move` already returned by `searchPersonaVoice`. Keep `interviewerLine()` for the spoken text.

Prompt rules (short):

- Match the move to **this** learner turn, not a fixed recipe.
- Acknowledge only if they added a claim worth locking or you are about to challenge / correct them.
- After a short complete answer: confirm in a few words, or skip ack and ask.
- After a wrong or uncertain answer: correct or “no problem”, then one ask. Do not fake “got it”.
- Do not start with the same opener as the previous trainer turn.
- One real question. Do not paraphrase the whole last answer unless you are about to challenge a specific claim.

Keep the content contract, fact-leak rules, and word limit.

### A.2 Stop forcing `move: probe`

**File:** `web/lib/runtime/openai.ts` (`retrievePersonaMoments`)

Today:

```ts
"move: probe",
…
searchPersonaVoice(..., { action, learnerState, limit: 6 })
```

Change:

- Query string: `learner_state`, `action`, `pending_question`, `last_learner`. No hardcoded move.
- Filters: `action` + `learnerState` only. Empty → existing persona-only fallback in `searchPersonaVoice`.

`learnerStateFrom()` is already wired at the completions call site.

### A.3 Recency guard

**File:** `web/lib/runtime/runtime.ts` (`validatePersonaRewrite`)

One check: if the rewrite’s first 3 words (lowercased, punctuation stripped) match the last assistant turn, push `"repeated opener"`.

Existing retry in `renderPersonaSpeech` already re-calls once with `priorErrors`. No new control flow.

Helper can live next to `validatePersonaRewrite`. Ceiling: string prefix, not a model.

**File:** `web/lib/runtime/runtime-check.test.ts`

- Same opener as last trainer turn → `repeated opener`.
- Different opener, same topic → no recency error.
- Existing leak / invented-mention cases still pass.

### A.4 Bench learner palette

**File:** `bench/learner_persona.py`

Starters are optional, not a prefix:

- Often answer in the first sentence.
- Conversational markers (`yeah`, `so basically`) at most every few turns, never the same one twice in a row.
- Keep the project facts, blind spots, and anti-overfitting rule.

**File:** `bench/test_simulate.py` — assert the anti-stamp line exists; drop the assertion that `"So basically"` must appear as a required opener if it no longer does.

### A.5 Verify

```bash
cd web && bun test lib/runtime/runtime-check.test.ts lib/persona-voice.test.ts
cd bench && uv run python test_simulate.py
BENCH_AGENT_SLUGS=sample-1 BENCH_REFERENCE_PERSONA_SLUG=vasanth uv run python simulate.py
```

**Gate (same scenario as `bench/results/latest.json`):**

| Signal | Now | Target |
|---|---|---|
| `got it, got it` / `okay, got it` as opener | ~9/13 turns | ≤ 2 / run, and not consecutive |
| `likeness.filler_rate` | 0.69 | toward ~0.15 |
| Label leaks (`in your own words`) | 3 | not worse |
| Learner `Yeah, so` / `So basically` prefix | most user turns | not every turn |
| Fidelity / completeness / role | 1.00 / 0.86 / 1.00 | still pass 0.7 |

If the twin goes generic (`That's helpful…`) instead of Vasanth, tighten A.1 with YAML `examples` — do not bring the GOOD template back.

---

## Phase B — only if A still stamps

Change embed shape, then reindex. Skip unless A fails the gate.

### B.1 Situation line on embed text

**File:** `web/lib/persona-voice.ts` (`formatEmbedText`)

```
LearnerState: vague
Action: request_justification
Interviewer: How did you measure that?
```

Still **no** `Candidate:` line. Update `persona-voice.test.ts` (`omits candidate speech` stays; `includes("Candidate:") === false` stays).

### B.2 Reindex

```bash
# existing script
web/scripts/reindex-persona-sources.ts
```

Old blobs remain searchable; new text is additive. No Prisma migration.

### B.3 Optional deterministic ack hint

**File:** `web/lib/runtime/openai.ts`

If prompt-only still over-acks, pass one hint into the rewrite (not a spoken prefix):

- last learner < ~20 words and not uncertain → `ack: skip`
- uncertain / wrong → `ack: repair`
- long claim, about to challenge → `ack: lock`

Stdlib over a model. Add only if A.1 is not enough.

---

## Out of scope unless asked

- Per-account / per-session filler budget.
- New ConversationalGEval criterion for filler diversity.
- Touching LiveKit / TTS.

## Order of work

1. A.1 prompt
2. A.2 retrieval query
3. A.3 recency validator + tests
4. A.4 bench learner
5. A.5 bench run
6. Phase B only if the gate fails
