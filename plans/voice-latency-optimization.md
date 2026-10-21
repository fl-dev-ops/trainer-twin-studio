# Voice latency optimization — resume rounds (Oct 13–16, 2026)

Goal: cut the time from "learner stops talking" to "trainer starts speaking" on the production-shaped path
(voice agent → Eve chat brain → Gemini), measured per segment, without losing interview quality.

Production path: `agent/` (LiveKit voice agent) → `LLM_BASE_URL` → Eve `chat/` (`/v1/chat/completions` bridge in
`chat/agent/channels/openai-compat.ts`) → Vercel AI Gateway → Gemini. Prod voice agent points at Eve
(`agent/stack.yml`: `LLM_BASE_URL=https://chat.trainertwin.com/v1`), not the web runtime.

---

## 1. Results

Start = first measured resume round (`bench/results/demo-eve-gemini-v1.json`, Oct 13).
Today = two final sessions, same setup (`bench/results/final-vertex-low-nohedge.json`,
`bench/results/final-with-closing.json`, Oct 15–16). Medians from instrumentation.

### New project question (next resume item + highlight)

| Segment | Start | Today |
|---|---|---|
| STT (Deepgram flux) | 0.21 s | 0.05 s |
| End-of-turn detection | 2.00 s | 1.20 s |
| Eve setup | 0.35 s | 0.42 s |
| LLM calls before first word | 4 | **1** |
| LLM time to first word | 14.0 s | **3.0 s** |
| Transport (voice ↔ Eve) | 0.05 s | 0.02 s |
| TTS first audio (VoxCPM2) | 0.39 s | 0.39 s |
| Playback | 0.04 s | 0.03 s |
| **End to end** | **16.5 s** | **5.1 s** |

### Follow-up

| Segment | Start | Today |
|---|---|---|
| End-of-turn detection | 1.30 s (≤2.0) | 1.20 s |
| LLM calls before first word | 2 | **1** |
| LLM time to first word | 4.9 s | **3.2 s** |
| **End to end** | **6.9 s** | **4.8 s** |

### Other turns

| Turn | Start | Today |
|---|---|---|
| Intro → first question | 19.6 s | 6.5–11.8 s (2 calls; plan is set up on this turn) |
| Closing feedback | ~19 s (3 calls + style lookup) | ~3.4 s Eve first word (1 call) |
| Learner trails off | graded as an answer, moved on | ~4.5 s, "Take your time — go on" (not graded) |

### A typical turn today (~4.8 s)

End-of-turn 1.2 s (25%) · Eve setup 0.4 s (9%) · Gemini 3.0–3.2 s (65%) · transport+TTS+playback 0.45 s (9%).
Everything else (highlight, recording, knowledge, style, claim prefetch, second silent LLM call) runs while the
trainer is already speaking.

---

## 2. What changed (by component)

### Eve chat brain (`chat/`)
- **One LLM call per turn** (`chat/agent/lib/plan-turn-block.ts`, `chat/agent/instructions/plan-turn.ts`): a per-turn
  block (Eve `turn.started` dynamic instruction) gives the model the plan state, what each grade leads to
  (computed by running the real plan logic on a copy), candidate claims, trainer style and knowledge — so it can
  grade + respond in one response.
- **Speech travels inside the tool call; the bridge speaks it immediately** (`chat/agent/lib/question-bridge.ts`):
  Gemini returns either tool calls or text, never both. `start_resume_question.question` and
  `session_plan.reply` are streamed to the voice agent as soon as the call is requested (trailing newline matters —
  see voice agent). Repeats after a confirmed highlight are dropped; a follow-up reply whose grade leads to a new
  question is held (no double question); spent claims are never re-spoken; ≤1 bridged question per turn.
- **`session_plan`** (`chat/agent/tools/session_plan.ts`): optional `reply`; prefetches + caches next resume claims
  (`chat/agent/lib/resume-candidates.ts`); one recorded answer per turn (`recordAnswerOnce`, guard against the model
  re-recording to skip a follow-up); starts closing itself on a one-call closing turn.
- **`start_resume_question`**: optional `answerStatus`/`evidenceUpdates` so a new question is one call; if the plan
  wanted a follow-up, the plan follows what the learner heard (`moveToNextMainQuestion`); fetches style (once) and
  project knowledge in parallel *after* the highlight, while speaking.
- **Plan rules** (`chat/agent/lib/session-plan.ts`): "I don't know" once → one different-angle follow-up; twice in a
  row → next question.
- **Per-turn grounding without extra calls**: trainer style cached once per session (`chat/agent/lib/style-cache.ts`,
  `ensure-style.ts`; situations: follow-up, don't know, next question, closing); project knowledge for technical
  follow-ups (`chat/agent/lib/project-knowledge.ts`, Acme Knowledge, only when relevant).
- **Rules in the block**: incomplete-answer rule (trail-offs → plain-text "go on", no grading); explicit "which grades
  allow a new question"; one-call closing + confirmation block (questions in plain text; "yes" → `confirm_end` +
  `finish_session`).
- **Model settings** (`chat/agent/agent.ts`): Gemini `thinkingLevel: "low"`; Google backend via
  `GEMINI_GATEWAY_PROVIDER`; optional same-route hedge (`chat/agent/lib/hedge.ts`, off).
- **Instrumentation**: `[brain-trace]` per turn (per-LLM-step timing, decision vs tool time, tokens, cached tokens,
  `spoke`, tool inputs/outputs summary, bridged/held, plan mismatch, `llm_model`, `llm_route`),
  `[plan-turn]` per turn (what the model was shown), `[openai-compat] request` per transport request.
  Normal telemetry omits learner input, spoken text, tool text prefixes, and tool error messages. Each turn has
  one `[brain-trace]` log and one `brain_trace` in the final SSE chunk.

### Voice agent (`agent/`)
- **Finished sentences go to TTS when Eve's text pauses ≥200 ms** (`agent/src/tts/sentence_flush.py`): LiveKit only
  sent a sentence to non-streaming TTS when the next sentence started or the stream closed. `TTS_IDLE_FLUSH_MS`
  (0 = off). Also note LiveKit's markdown filter holds the last word until a newline — the bridge appends `\n`.
- **End-of-turn `max_delay` 2.0 → 1.2 s** (`agent/src/session.py`). Safe now that trail-offs get "go on".
- **`[voice-latency]` events** carry `createdAtMs`, `loggedAtMs`, `interrupted` for joining with Eve traces.

### Bench (`bench/`)
- `voice_latency_report.py`: joins voice events with Eve `[brain-trace]` (timestamp join, dedupe), reads Eve's JSON
  dev log, per-stage breakdown (`turnBreakdownMs`, `brainStagesMs`, `turns`).

---

## 3. Configuration

### `chat/.env` (local, gitignored) — set the same in the chat app's Vercel project
```
CHAT_AGENT_MODEL=google/gemini-3.8-flash
GEMINI_GATEWAY_PROVIDER=vertex        # google = AI Studio (default), vertex = Vertex AI
PROJECT_KNOWLEDGE=on                  # off skips knowledge lookup + block section
GEMINI_HEDGE_AFTER_MS=0               # duplicate stalled calls after N ms; 0 = off
GEMINI_HEDGE_BACKUP_ROUTE=vertex      # MUST be the same backend (see §4.6)
# optional: GEMINI_THINKING_LEVEL (default low), GEMINI_THINKING_BUDGET (overrides level; not honoured by 3.8)
```
Code fallback model when `CHAT_AGENT_MODEL` is unset is `google/gemini-3.5-flash-lite` — make sure prod sets it.
`GEMINI_THINKING_BUDGET` and `x-thinking-budget` must be `-1` (dynamic) or a non-negative safe integer.
Invalid headers return HTTP 400 before an Eve turn is sent; invalid environment overrides fail model selection.

### `agent/.env` (local)
`LLM_BASE_URL=http://127.0.0.1:2001/v1`, `LLM_MODEL=trainertwin-brain` (local Eve). Optional `TTS_IDLE_FLUSH_MS`.

---

## 4. Findings (keep these — they took a while to learn)

1. **LLM calls before the first word are the main lever.** Each Gemini call costs a ~2.1–2.7 s floor on a ~23k-token
   prompt; serial calls add up. Everything not needed for the spoken words must run after speech starts.
2. **Thinking tokens drive the slow calls.** Fit over 256 calls: `time ≈ 2.7 s + 8.4 ms × output tokens` (~118 tok/s,
   output includes thinking). Heavy-thinking calls (300–3,000 tokens) take 5–20 s.
3. **Heavy thinking comes in time windows, not from our prompt.** Session prompts are byte-identical except a
   timestamp; the same opening prompt gave 383 thinking tokens in a heavy session and 20–31 in 42 replays later.
   The opening's output tokens predict the session (heavy opening → heavy turns). Seen on AI Studio and Vertex.
4. **Thinking can't be capped on Gemini 3.8 Flash.** `thinkingLevel: "minimal"` → 400; `thinkingBudget: 0` accepted
   but not enforced (AI Studio and Vertex); capping output tokens truncates the answer. `"low"` is the best setting.
5. **Stalls are a separate problem**: ~5–7% of calls take 10–22 s with a normal-sized answer (no extra thinking) —
   per-request waiting at the backend. The next request is usually normal.
6. **Hedging (duplicate request after N s):** useless for heavy thinking (the copy thinks as long), helps stalls.
   **Never hedge across routes**: Gemini 3 thought signatures are backend-bound; a Vertex request with history from an
   AI Studio answer fails `400 Invalid thought signature`, the Eve turn fails and the session state is lost (plan
   restarted → "claims kept going"). Same-route hedge works but fired on ~every call in a heavy window for 1 win → off.
7. **Vertex vs AI Studio:** same model; Vertex had the best stretch of turns but also stalls and heavy windows.
   Implicit cache hits are mostly 0% on Vertex yet calls were fast.
8. **Caching:** implicit cache covers the static prefix (~18–20k tokens); the per-turn block is in the system prompt
   before the conversation, so history isn't cached. A full miss costs ~1–1.5 s — much smaller than thinking.
   Explicit caching (`cachedContents`) would need BYOK / own Google project via the gateway.
9. **Knowledge does not slow turns** (40-call A/B: 4.52 vs 4.56 s median; slow sessions happened with and without it).
   The lookup itself is ~1.1 s warm / ~2.9 s cold (embedding via gateway → OpenAI + Chroma Cloud query), off-path.
10. **Highlight** ≈ 1.1–1.9 s (two 500 ms polling loops web ↔ browser); runs while the question is spoken.
11. **Endpointing at 1.2 s** cuts mid-thought pauses into fragments — harmless only because of the incomplete-answer rule.
12. **Gemini 3.5 Flash-Lite** is ~3× faster but broke turn rules in a real session (reply missing, new question inside a
    follow-up reply → no highlight, grade attached on the intro turn → plan off by one).

---

## 5. Model benchmark (for the next step)

Same real follow-up prompt (instructions + per-turn block + style), 6 calls each, interleaved, Oct 16. Time = until
the complete tool call (when Eve can speak). Correct = exactly one `session_plan` with grade + usable reply.

| Model | Median | Worst | Correct | Notes |
|---|---|---|---|---|
| anthropic/claude-haiku-4.5 | **1.06 s** | 2.42 s | 6/6 | wordier, multi-part questions; **writes narration text + tool call** ("I'll record that answer…") |
| google/gemini-2.5-flash (`thinkingBudget: 0`) | **1.47 s** | 2.42 s | 6/6 | concise; budget honoured on 2.5; still listed on the gateway (check Google deprecation dates) |
| deepseek/deepseek-v4.1-flash-fast | **1.77 s** | 2.06 s | 6/6 | natural, uses name; no extra text; tested on gateway default route |
| alibaba/qwen3.8-27b (Cerebras) | 2.00 s | 3.34 s | 6/6 | |
| google/gemini-3.8-flash (Vertex, low) — current | 2.32 s | 2.41 s | 6/6 | light window during the test |
| google/gemini-3.5-flash | 2.36 s | 4.19 s | 6/6 | |
| google/gemini-3.5-flash-lite | 2.39 s | 3.16 s | 6/6 | broke rules in a real session |
| openai/gpt-5.4-mini (reasoning none) | 1.44 s | 3.00 s | 1/6 | jumps to new questions |
| openai/gpt-oss-120b (Groq) | 3.38 s | 4.20 s | 4/6 | 1 error |

Estimated end to end with today's other segments: Haiku ~3.6 s, Gemini 2.5 Flash ~3.9 s, DeepSeek ~4.2 s (vs ~4.8 s).
Untested: behaviour across heavy windows/time of day, full sessions, cost.

### To try a model (keep the prompt model-agnostic)
- **DeepSeek V4.1 Flash**: ready to try. `agent.ts` currently pins `deepseek/*` to DeepInfra — set the route to match
  what was benchmarked (gateway default) in a per-model config.
- **Gemini 2.5 Flash**: needs a per-model config — it must get `thinkingBudget: 0`, not the Gemini-3 `thinkingLevel`.
- **Claude Haiku 4.5**: needs (a) a generic rule "when you call a tool, write no other text; everything the learner
  hears goes in `reply`/`question`", and ideally (b) a bridge safety net: if a response has text + a reply-carrying
  tool call, speak only the reply (requires briefly holding text until the step's tool calls are known).
- Turn `agent.ts`'s per-family branches into one **per-model config table** (thinking settings, gateway route,
  provider options) so models switch by `CHAT_AGENT_MODEL` alone.

---

## 6. Open items / next steps

1. **Model trial** (§5): per-model config → DeepSeek V4.1 Flash and Gemini 2.5 Flash sessions → Haiku after the
   no-narration rule + bridge safety net.
2. **Held-reply turns cost 2 calls**: after a strong answer the model sometimes writes a follow-up reply (held) before
   the highlight call. Tell the model its reply was held, or tighten the rule for strong answers.
3. **Intro-turn safety fix**: plan setup should count as that turn's recording so a grade attached to the first
   `start_resume_question` is ignored (seen with Flash-Lite).
4. **Eve state loss on a failed turn**: one failed LLM call reset the whole session plan. The plan should survive a
   failed turn.
5. **Knowledge**: prefetch knowledge for the top claims at session start (results ready at 0 s); run knowledge in
   parallel with the highlight instead of after (tool ~4.5 s → ~3 s, less risk of cancellation by a quick answer).
6. **Highlight**: push commands to the browser (e.g. LiveKit data channel) instead of 500 ms polling (~0.5–1 s sooner).
7. **Caching**: move the per-turn block after the conversation (history becomes cacheable); explicit `cachedContents`
   if BYOK is set up.
8. **Reply streaming**: speak `reply` while it's generated instead of after the complete tool call (~0.5–1 s), if Eve
   exposes partial tool input.
9. **Stalls**: smarter hedge that only fires on stalls (e.g. when no thinking parts arrive), same route only.
10. **Technical rounds still use the multi-call flow** (checked in a Foundational Depth round, Oct 19 — behaviour was
    correct, no regression; the one-call path was only built for resume questions). Measured:

    | Turn | Today | Target | Est. saving |
    |---|---|---|---|
    | New technical question **with a surface** (MCQ, code editor, whiteboard) | 3 calls: `session_plan` → `surface(open…)` → speak, ~10.1–10.4 s Eve first word | 1 call: `session_plan(record_answer, reply=<question>)` + `surface(open…)` in the same response; bridge speaks the reply while the surface opens | ~6–7 s |
    | New verbal technical question | 2 calls, ~4.3 s | 1 call via `reply` (same pattern as follow-ups) | ~1.5–2 s |
    | Follow-up that must **inspect the learner's work** (`get_choice_state`, `read_code_range`, `read_canvas_scene`) | 2 calls: inspect → `highlight_*` + `session_plan(reply)`, ~8.8–11.1 s | 1 call: Eve reads the MCQ choice / code / canvas **in code at turn start** (like the style cache) and puts it in the per-turn block | ~3–5 s; hardest — browser state must be fast and accurate |

    Rows 1–2 reuse the proven resume pattern (per-turn block rule + bridge speaks the `reply`; extend the bridge and
    plan block for technical question types and surface opening). Row 3 needs a new mechanism (turn-start workspace
    snapshot). Keep the existing rules: inspect before following up on visible work; close surfaces at closing.
11. **AI Gateway credits**: on Oct 19 the gateway ran out of credits mid-session ("A positive credit balance is
    required…") — every LLM call failed and the trainer went silent. Add a balance alert / auto top-up, and make the
    voice agent say something when the brain errors instead of staying silent.

---

## 7. How to measure

```bash
# terminals: web (bun run dev), Eve (cd chat && bunx eve dev --port 2001),
# voice agent:
cd agent && uv run python src/agent.py dev 2>&1 | tee /tmp/voice-agent.log
# after a session:
cd bench && uv run python voice_latency_report.py /tmp/voice-agent.log ../chat/.eve/logs/dev-*.log \
  --label <name> --output results/<name>.json
```
Eve's own log: `chat/.eve/logs/dev-*.log` (JSON lines; `[brain-trace]`, `[plan-turn]`, `[openai-compat] request`,
`[hedge]`). Useful per turn: `calls_before_first_word`, `llm_call_N_decision|ttft|tools`, output/cached tokens,
`spoken_text`, tool inputs/outputs, `held_replies`, `plan_mismatch`.
