# Issue: Persona Speech Validation Loop — Latency & False Rejections

> **Status: DESIGN LOCKED (2026-09-11), not yet implemented.**
> During design discussion we chose a solution that goes *beyond* the original
> options A–D below: instead of tuning the regex validators, they are **replaced
> entirely** by LLM self-assessment inside the generation call. Section 4
> documents the original options and Section 6 documents the chosen design, what
> changed from the original plan, and why — kept for future reference.

## 1. Context & Symptom

Observed in production (dash.trainertwin.com, Vercel logs) during live `/talk`
sessions on 2026-09-11:

```
[interview-runtime] persona validation failed { errors: [ 'too many questions', 'stacked questions' ] }
[interview-runtime] persona validation failed { errors: [ 'too many questions', 'stacked questions', 'persona fact leak' ] }
```

The runtime regenerates persona speech and repeatedly fails validation before
accepting output — adding seconds of dead air before the trainer speaks, and
when the retry also fails, degrading to the templated `deterministicFallback`
even though OpenRouter is perfectly healthy.

Source: `renderPersonaSpeech()` in `web/lib/runtime/openai.ts` →
`validatePersonaRewrite()` in `web/lib/runtime/runtime.ts`.

## 2. Current Behavior (pre-fix)

```
① direction 🤖 ~1.4s
② analyzer  🤖 ~1.5s
③ persona moments retrieval (Chroma) → contract built locally
④ speech    🤖 ~1.5s → regex validator → fail?
⑤ retry     🤖 ~1.5s with errors fed back → fail again?
⑥ discard BOTH drafts → deterministicFallback() (canned robot line)
```

- Worst case: 4–5 sequential LLM calls ≈ 6s, colliding with the ~4s per-request
  deadline / agent 5s read timeout (`plans/issues_openrouter-resilience.md`) —
  a looping turn risks `APITimeoutError` killing the turn entirely.
- `validateRendered`/`validatePersonaRewrite` judge with regexes:
  - `BACKCHANNEL_ASK` (runtime.ts) only whitelists `correct/right/okay/ok/got
    it/no problem/shall we?` — any other natural backchannel ("alright?",
    "yeah?", "makes sense?") counts as a *real* question → "too many
    questions" / "stacked questions" on faithful persona imitation.
  - `properTokens` fact-leak check flags capitalized words present in persona
    moment lines but not in learner text/transcript/scenario — the model is
    handed 6 real Vasanth lines to imitate and then punished for vocabulary
    from them.

## 3. Root Causes (confirmed during design)

1. **Prompt/validator contradiction** — the prompt invites backchannels while
   the validator's hardcoded whitelist rejects most of them.
2. **Fact-leak regex can't know context** — a token-overlap check cannot tell
   "copied a fact" from "legitimately used domain vocabulary".
3. **All-or-nothing discard** — any single validation error kills the draft;
   retry failing → both drafts discarded → canned fallback.
4. **No telemetry** — failures only as stray `console.warn` lines.

## 4. Original Fix Options (superseded by Section 6)

- **A. Align prompt with validator** — make backchannel guidance explicit and
  measured; teach the validator the same rule.
- **B. Best-of-2 instead of fallback** — on persistent validation failure,
  return the draft with fewest errors rather than the robot template.
- **C. Tune the fact-leak check** — widen the allowed-token set.
- **D. Telemetry** — persona attempt count + error reasons + fallback count in
  the `completion served` log.

## 5. Design Decision & Rationale (why we went beyond A–D)

Original options assumed the regex validator stays and gets patched. Design
discussion concluded the validator itself is the wrong tool:

- **Layering violation:** question count is decided at the content layer (the
  contract already fixes "one question about X"); re-checking it at the persona
  layer re-litigates a settled decision, using rules the model was never shown
  (the backchannel whitelist lives only in the validator).
- **A regex cannot judge naturalness** — and naturalness is the entire point of
  the persona layer. Judgment of speech quality is an LLM-shaped job.
- Design principle adopted: **every quality decision is LLM-reasoned, given the
  specs.** Specs are the single source of truth; rules live in the prompt where
  the model can reason against them, not in hidden regexes it cannot see.

What this buys: the contradiction class of failures disappears (the model
judges with the same rules it was given), the loop cost drops (compliance
reasoning rides inside the call we were making anyway), and latency goes
*down* (3 calls/turn instead of 4–5).

## 6. Chosen Design — LLM Self-Validated Speech (to implement)

### New speech pipeline (one speech call instead of two layers)

```
① direction 🤖            (unchanged)
② analyzer  🤖            (unchanged)
③ knowledge retrieval      (unchanged)
④ persona moments retrieval (unchanged — still the voice few-shots)
⑤ speech+compliance 🤖     ONE call: specs + persona voice lines + content
                           contract in the system prompt; returns JSON:
   {
     "reasoning": {
       "one_real_question":  { "ok": bool, "why": "..." },
       "no_copied_facts":    { "ok": bool, "why": "..." },
       "no_invented_mention":{ "ok": bool, "why": "..." },
       "word_budget":        { "ok": bool, "why": "..." },
       "in_persona_voice":   { "ok": bool, "why": "..." }
     },
     "spoken_text": "..."
   }
```

### Failure policy

- 0 flags → speak immediately (the common case).
- Flags → one retry with the flagged reasons fed back into the prompt.
- Retry still flagged → speak the draft with **fewer flags** (best-of-2).
  Never degrade to `deterministicFallback` while a non-empty, parseable draft
  exists. Fallback only if drafts are empty/unparseable (catastrophic).

### What replaces what

| Removed | Reason | Replaced by |
|---|---|---|
| `validatePersonaRewrite` | regex cannot judge speech | model's per-rule reasoning |
| `validateRendered` spoken checks (focalAskCount/hasStackedAsks at persona layer) | decided at content layer; regex whitelist misses natural backchannels | model's `one_real_question` reasoning |
| `properTokens` fact-leak intersection | can't distinguish copied fact from domain vocab | model's `no_copied_facts` reasoning |
| content-generation stage when persona moments exist (already skipped) | — | unchanged: contract still built locally |
| `deterministicFallback` as the loop exit | discards usable drafts | best-of-2 selection |

Mechanical (non-judgment) code that remains: JSON schema validation of the
structured output, flag counting / loop bounds (retry once), hard word ceiling
only for catastrophic overshoot, and the "you mentioned X" substring confirm if
needed as a cheap schema-level assert. No regex judges the English anywhere.

### Behavior differences at a glance

| Situation | Old | New |
|---|---|---|
| Persona says "alright?" / "yeah?" | rejected: too many questions | passes (model reasons it's a backchannel) |
| Copies a real fact ("Rocket") from moment lines | whole draft discarded → robot | self-flagged → retry fixes → speak |
| Two real questions | retry → robot | flagged → retry → best-of-2 |
| Retry fails | canned fallback always | best-of-2; fallback only if empty |
| LLM calls per graded turn | 4–5 | 3 |
| Worst-case latency | ~6s (over deadline) | ~4.5–5s |
| Observability | stray console.warn | flags + reasons + fallback count in `completion served` |

## 7. Implementation Notes

- Touches `generateContentSpeech` / `renderPersonaSpeech` in
  `web/lib/runtime/openai.ts`; retires both regex validators in
  `web/lib/runtime/runtime.ts` (mostly **deletion**).
- `renderRules`-derived limits (word/question caps) move into the speech
  prompt as spec-sourced rubric lines.
- Structured output via `response_format: json_object` (temperature 0-ish) —
  reasoning first, `spoken_text` last.
- Self-check bias caveat: the author judging its own work is lenient by
  nature. Mitigation: rubric-style per-rule justification in the output, prior
  flags fed into the retry, and telemetry counts flags per turn. Escape hatch
  if self-check proves too lenient: a separate judge call (4th round-trip) —
  only add if telemetry proves the need.
- **Deferred (explicitly out of scope):** action-aware knowledge retrieval
  (knowledge query currently uses transcript+objective only; matching it to
  the chosen action is a separate small improvement — do NOT bundle here).

## 8. Acceptance Criteria

- [ ] Telemetry: flags per turn, error reasons, retry count, fallback count in
      the `completion served` log.
- [ ] No silent `deterministicFallback` while a usable draft exists
      (best-of-2 selection implemented and tested).
- [ ] Prompt and self-check agree on question/backchannel rules — spot-check
      against 5+ real transcripts (natural backchannels pass first attempt).
- [ ] End-to-end pipeline stays under the ~4s per-request deadline even when
      the speech stage retries once (3 LLM calls per graded turn).
- [ ] Existing runtime tests still pass after validator retirement; add tests
      for: best-of-2 selection (fewer-flags wins), retry-on-flags flow,
      fallback only on empty/unparseable drafts, and one natural-backchannel
      case passing self-check.

## Related

- `plans/issues_openrouter-resilience.md` — latency budget & failure policy
  (this design removes the quality-driven retry layer's extra round-trips).
- `plans/issues_chat-completions-stabilization.md` — pipeline architecture.
