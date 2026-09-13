# Issue: Move Decisions From Past Situations (Restore Episode-Driven Behavior)

## Status: OPEN — deferred from the Option-B production port (2026-09-13)

## 1. Context

The `/api/v1/chat/completions` learner turn was rewritten to the validated Option-B
pipeline (`web/experiments/variant-option-b/`, median ~5.5s, 88/88 tests passing).
That pipeline decides the trainer's conversational move from **fixed rules baked into
the classifier prompt** (probe / challenge / hint / acknowledge_advance / clarify /
redirect / close) and retrieves only **style** examples (how the trainer phrases things).

Two behavior-retrieval stages from the old pipeline no longer run on learner turns:

- **Situation episodes** (`persona_voice_episode`) — "what did the trainer DO in a
  similar situation before" — the trainer's actual decision-making evidence.
- **Knowledge RAG** — domain references from attached course material.

## 2. Why this is a problem (architectural, not cosmetic)

Product constraint: *quality decisions should be LLM-reasoned from the trainer's real
material; code/rules handle only mechanics and bounds.* The fixed move taxonomy
violates it:

- Any situation outside the 7-move taxonomy (candidate freezes mid-sentence, learner
  challenges the trainer, multi-part partial answers, candidate teaches the trainer)
  has no fitting move — the model forces the situation into the nearest bucket and
  stops behaving like the trainer.
- The trainer's real judgment lives in their episode index. Rules cannot adapt;
  recorded past behavior can.

## 3. Target design (agreed 2026-09-13)

```text
Learner speaks
│
├─ 1. Situation query built mechanically from transcript + latest message (0 ms)
│
├─ 2. PARALLEL RETRIEVAL (overlapped, ~1.3–1.5s):
│     ├─ EPISODES: 2–3 past situations — what the trainer DID in similar moments
│     └─ STYLE:    5 phrasing examples — HOW the trainer speaks
│
├─ 3. MOVE DECISION (1 LLM call, ~1.5–1.7s) — now informed by the trainer's own
│     past decisions ("in a similar situation you probed the mechanism first").
│     Fixed moves demote to a fallback/label vocabulary, not the decision input.
│
└─ 4. One styled generation (~1.3s) using episodes + style + decided move
     TOTAL stays ≈ 5.5s because retrieval runs before/parallel with the decision
```

Key insight that resolves the earlier "pre-fetching is a guess" problem: the situation
does not need the move to be known first — past situations are the evidence FOR
choosing the move. Retrieval moves before the decision instead of after.

## 4. Tasks

- [ ] Build the situation query mechanically (no LLM): learner's latest message +
      pending question + current topic.
- [ ] Fetch episodes + style in parallel on the learner turn (respect the Chroma
      single-lane serialization; episodes and style enter the lane together).
- [ ] Extend `classifyMove` (web/lib/runtime/openai.ts) to receive the episode
      evidence and reason the move from it; keep the fixed-move JSON as fallback
      when retrieval is empty.
- [ ] Feed episode summaries into `generateStyledSpeech` ("how you handled a similar
      situation"), keeping behavior examples fact-free (no copying learner facts).
- [ ] Knowledge RAG: restore as on-demand only (classifier already emits
      `document_lookup`; consider the same for KB when the move needs grounding).
- [ ] Re-validate: bench (median ≈ 5.5s or better), 45-turn sim quality, 88 tests.

## 5. Related

- `plans/issues_ingestion-name-redaction.md` — name redaction at ingestion time
  (opening turn still bleeds the résumé's name, e.g. "Hi Harini").
- `plans/issues_persona-validation-loop.md` §10 — style index design (episodes vs styles).
- `plans/issues_speech-style-and-show-and-tell.md` — spoken-first + deictic surfaces
  (both preserved in the port).
- Background rubric analyzer (Variant 2) — separate follow-up to restore the
  assessment scorecard (evidence/coverage/claims) at zero perceived latency.
