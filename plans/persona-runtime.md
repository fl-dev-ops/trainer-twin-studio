# Persona-conditioned interview runtime

## Goal

Ship a TrainerTwin that runs a **fair, spec-bounded interview** and sounds like the selected persona **from gathered data**, without leaking that persona’s life into the candidate’s story.

Likeness is interviewer manner (probe, acknowledge, follow-up), not a biographical clone.

## Contract

| Layer | Source of truth | Corpus may override? |
|---|---|---|
| Interview law | Agent + domain specs + runtime state | No |
| Next legal move | `selectAction`, then persona vote among allowed actions | Only inside the allow-list, same evidence key |
| Wording | Persona moments + YAML language habits | Yes, if meaning is preserved |

Hard locks: persona never overrides `close_session`, `transition_phase`, `surface_contradiction`, `finish_session`.

Persona moments never enter direction, analysis, or content prompts. Knowledge hits never enter the rewrite prompt.

## Non-goals

- Latency work (later).
- Fine-tuning on raw transcripts.
- Merging knowledge and persona indexes.
- Blocking sessions when the persona index is empty.
- Changing LiveKit / TTS / STT.

## Current gaps (from live session `cmtvx7sfu0000rwse08d5xqbg`)

- Quote-ungated / probe-exhausted coverage marked strong answers `weak`.
- Generic-praise regex misses curly apostrophes; validation failure replayed `pending_question`.
- Content draft stacked multiple asks behind one `?`.
- `current_topic` went stale.
- Persona rewrite no-oped (zero moments; topic-shaped query even if moments existed).
- Ingest stores moments as text blobs; `PersonaVoiceMetadata.action` is unused.

---

## Phase 1 — Make the interview machine trustworthy

Do this before any likeness work. A twin on a broken grader will be confidently wrong.

### 1.1 Quote-gated evidence

**Files:** `web/lib/runtime/runtime.ts`, `web/lib/runtime/openai.ts`, `web/lib/runtime/runtime-check.test.ts`

- `applyEvidenceUpdates`: ignore updates whose `quote` is missing or not a substring of the latest learner text (already partly in `validateAnalysis`; enforce again before coverage write).
- `markProbeExhaustion`: do not set `weak` when current coverage is `sufficient`.
- Analyzer prompt: if classification is `strong` or `partial` and there is no quotable update, force `vague`/`unknown`.
- Closing text (`closingAction`, `feedbackSummary`) reads persisted `state.coverage` only.

**Tests**

- Quoted sufficient update survives two probes.
- Unquoted update does not change coverage.
- Close summary uses coverage, not the last LLM recap.

### 1.2 Validation and fallback

**Files:** `web/lib/runtime/runtime.ts` (`validateRendered`, `deterministicFallback`), `web/lib/runtime/openai.ts` (`generateContentSpeech`, `renderPersonaSpeech`)

- Normalize apostrophes before praise checks (`that's` / `that’s`, `you've` / `you’ve`).
- Treat stacked asks as invalid even with one `?` (`and how`, `including`, `;`, comma-joined interrogatives). Keep this conservative; add cases from the live transcript.
- On validation failure: one regeneration with the error list. If still invalid, ship the **content draft**, never replay `pending_question` after a gradeable answer.
- Repeat/slow-down turns still restate `pending_question`.

**Tests**

- `That's a solid example. Can you explain…` → `generic praise`.
- After a real answer, fallback ≠ previous trainer question.
- Repeat request → same pending question, `learner_turns` unchanged.

### 1.3 Continuity state

**Files:** `web/lib/runtime/openai.ts`, `web/lib/runtime/runtime.ts`

- Every spoken trainer question goes through `recordAskedQuestion`.
- After each graded turn, set `current_topic` from pending question + latest learner sentence (short, deterministic; LLM direction topic is a hint, not the only write).
- After 2 probes on the same evidence key with no new sufficient quote, `selectAction` must advance via `nextEvidence` / phase transition (the existing last-two-actions guard is not enough).

**Tests**

- Probe count increments only on gradeable asks.
- Third probe on the same key changes `evidence_key` or phase.

**Phase 1 gate:** rerun a manual fundamentals-depth conversation; no invented “you mentioned”, no duplicate question after an answer, coverage not weaker than quoted evidence.

---

## Phase 2 — Situation-shaped persona index

Likeness cannot work until retrieval matches *situation*, not topic.

### 2.1 Moment record

**Files:** `web/lib/persona-voice.ts`, `web/lib/main-collection.ts`, `web/lib/persona-voice.test.ts`

Extend extraction to return structured moments, not only strings:

```ts
type PersonaMoment = {
  text: string;
  action?: string;          // canonical action if present
  learnerState?: string;    // vague | partial | strong | confused | off_track | stop
  move?: string;            // acknowledge | probe | hint | restate | close
};
```

Map from existing Gemini analysis:

- `conversation_moments[].action` → `action`
- `conversation_moments[].candidate_context` + `interviewer_response` → `text` (keep `Candidate:` / `Action:` / `Interviewer:` body)
- `behavioral_patterns` keys (`on_vague_answer`, …) → `learnerState`
- `verbatim_phrases[action]` → `action`, `move: probe`

Infer `learnerState` from action when missing (`ask_exact_example` → vague, `deepen_with_tradeoff` → strong, etc.). Leave unset rather than guessing.

### 2.2 Metadata + ingest

**Files:** `web/lib/main-collection.ts` (`PersonaVoiceMetadata`, `ingestPersonaVoice`), `web/lib/persona-synthesis.ts` (call sites)

```ts
type PersonaVoiceMetadata = {
  type: "persona_voice";
  orgId: string;
  personaId: string;
  sourceId: string;
  sourceName: string;
  momentIndex: number;
  action?: string;
  learnerState?: string;
  move?: string;
};
```

Write these fields on upsert. Do not embed topic-only text as the sole retrieval key.

Reindex path: `web/scripts/reindex-persona-sources.ts` and `migrate-persona-voice.ts` must pass the new shape. Existing blobs remain searchable; new metadata is additive. No Prisma migration.

### 2.3 Retrieval API

**Files:** `web/lib/main-collection.ts` (`searchPersonaVoice`)

```ts
searchPersonaVoice(orgId, query, {
  personaId: string;
  action?: string;
  learnerState?: string;
  move?: string;
  limit?: number;
})
```

`where` always includes `{ type: "persona_voice", personaId }`. Add `action` / `learnerState` filters only when provided. If filtered query returns 0, retry once with `personaId` only (same query string).

**Query string (not full transcript):**

```text
learner_state: partial
action: isolate_missing_part
move: probe
pending_question: …
last_learner: …
```

Cap `last_learner` / `pending_question` to ~300 chars.

**Tests:** filter isolation by `personaId`; action filter used when set; empty filter fallback.

### 2.4 Runtime always styles

**Files:** `web/lib/runtime/openai.ts`

- Retrieve **after** action selection, using action + direction/analysis classification.
- If hits > 0 → rewrite.
- If hits = 0 → YAML `examples[action]` + `language.acknowledgments` / `bridges` / `calibration`. Still run a style pass (or a deterministic stitch of acknowledgment + content draft). **Do not return the raw content draft unlabeled as “persona.”**
- `personaVoiceAvailable === false` still allows YAML fallback; only skip Chroma.
- Content prompt must not include moment texts.

**Tests:** with mocked empty Chroma, output still uses YAML example phrasing or acknowledgments when present. With mocked hits, output is a rewrite of the same question.

**Phase 2 gate:** a session against an indexed persona logs moment ids per spoken turn; a session against an empty index still speaks, using YAML, without crashing.

---

## Phase 3 — Fact firewall

**Files:** `web/lib/runtime/runtime.ts` (new `validatePersonaRewrite`), `web/lib/runtime/openai.ts`, tests

After rewrite, reject if any of:

1. Question count / stacked-ask rules fail.
2. `you mentioned X` where X is not a substring of the learner transcript.
3. A proper noun / quoted project / metric appears in the rewrite and in a retrieved moment, but not in the transcript or agent scenario.
4. Internal evidence keys leak.
5. Role reversal / generic praise.

On fail: one rewrite retry with the error list. Then ship the **content draft**.

Keep the noun check cheap: extract capitalized tokens / quoted strings from moments vs transcript. Ponytail: no NER library.

**Tests:** moment containing “SQS FIFO at Acme” + learner talking about event loop → rewrite mentioning Acme fails. Paraphrase of the content question passes.

---

## Phase 4 — Persona vote among legal actions

**Files:** `web/lib/runtime/runtime.ts` (`selectAction` or a new `applyPersonaVote`), `web/lib/runtime/openai.ts`

After `selectAction`:

- Locked actions (`close_session`, `transition_phase`, `surface_contradiction`, `finish_session`, opening) → skip vote.
- Sparse index (`< N` moments for this persona, start with N=20, or no hits for this `learnerState`) → skip vote.
- Else consider allowed actions that share the selected `evidence_key`.
- Prefer an allowed action if retrieved moments for this `learnerState` majority-map to it (from metadata `action`) and it is not the same as the last two spoken actions.
- Never change `evidence_key`, phase, or close.

Log `{ controllerAction, votedAction, momentIds }` on the turn (console is enough; no new table).

**Tests:** locked action unchanged; majority vote switches `probe_required_evidence` → `isolate_missing_part` when both allowed; vote cannot close the session.

---

## Phase 5 — Product visibility and eval

### 5.1 Studio coverage (minimal)

**Files:** `web/lib/specs.ts` (`getAgentConfigForAgent` already has `personaVoiceAvailable`), persona source panel

- Count moments / distinct actions in Chroma (or `voiceMoments` on sources).
- Surface `low | medium | high` from source_count + distinct actions. Do not block Talk.

### 5.2 Bench regressions

**Files:** `bench/simulate.py`, new `bench/metrics.py` only if scoring is added later

Add goldens that assert, on the simulated `ConversationalTestCase` (string checks first, DeepEval metrics later):

- no invented `you mentioned` vs learner turns
- repeat request does not change topic
- at most one `?` and no stacked-ask pattern
- session eventually contains a close, or hits `max_user_simulations`
- when persona moments exist, at least one assistant turn differs from a YAML-only baseline (optional)

Keep the bench Python-only against `/api/v1/chat/completions`.

**Phase 5 gate:** one fundamentals-depth sim + one repeat-request sim pass locally.

---

## File map

| Area | Files |
|---|---|
| Controller / validation | `web/lib/runtime/runtime.ts` |
| Turn pipeline | `web/lib/runtime/openai.ts` |
| Compiler persona id | `web/lib/runtime/compiler.ts` (already uses `config.persona.id`) |
| Moment extract | `web/lib/persona-voice.ts` |
| Ingest / search | `web/lib/main-collection.ts` |
| Analysis → index | `web/lib/persona-synthesis.ts`, `web/scripts/reindex-persona-sources.ts` |
| Tests | `web/lib/runtime/runtime-check.test.ts`, `web/lib/runtime/runtime-e2e.test.ts`, `web/lib/persona-voice.test.ts` |
| Bench | `bench/simulate.py` |

No new services, queues, or Prisma models. No new npm/Python deps for phases 1–4.

## Implementation order (do not skip)

1. Phase 1 (grader + fallback)  
2. Phase 2 (index + retrieve + always style)  
3. Phase 3 (firewall)  
4. Phase 4 (vote)  
5. Phase 5 (coverage + bench)

Phase 4 on a topic-shaped index will vote on the wrong signal. Phase 3 before phase 2 has nothing to firewall.

## Ops / reindex

After phase 2 ships, reindex existing persona sources (`bun web/scripts/reindex-persona-sources.ts` or the migrate script). Sessions started before reindex keep old snapshots; likeness needs a **new** session after index + metadata exist.

YAML resynthesis stays background. Index write is the live path.

## Explicitly out of scope until later

- Parallelizing LLM stages (latency).
- Fine-tunes.
- Changing agent YAML evidence keys.
- Voice/LiveKit path (this plan is the `/api/v1/chat/completions` brain; the agent already consumes that).
