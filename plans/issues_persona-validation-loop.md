# Issue: Persona Speech Validation Loop — Latency & False Rejections

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

---

## 2. Current Behavior

1. `renderPersonaSpeech` calls OpenRouter (~1.3–1.6s measured).
2. `validatePersonaRewrite` checks the result; on errors, it recurses **once**
   with `priorErrors` injected into the prompt (second OpenRouter call).
3. If the retry also fails validation → `deterministicFallback(action, ...)` →
   the candidate hears a templated "Could you explain X in your own words?"
   despite all infrastructure being healthy.

Worst case per turn: 2 × persona calls + fallback ≈ 3s of pipeline time, on top
of the direction-check and analyzer calls. This collides with the hard latency
budget documented in `plans/issues_openrouter-resilience.md` (agent read
timeout ~5s; per-request deadline ~4s). A validation-looping turn risks the
agent-side `APITimeoutError` killing the turn entirely.

---

## 3. Root Causes (suspected, verify during implementation)

- **Prompt/validator contradiction:** the system prompt *encourages* backchannels
  ("Extra 'correct?' / 'okay?' backchannels are fine") while the validator rejects
  "too many questions" / "stacked questions" — natural interviewer speech with
  backchannels gets rejected.
- **`persona fact leak` token-overlap check** (`properTokens` intersection with
  moment texts minus allowed text) may misfire when persona moments quote
  domain vocabulary that is legitimately in the scenario/content contract.
- **No telemetry for the loop:** validation failures are only visible as stray
  `console.warn` lines; the `completion served` telemetry line doesn't record
  how many persona attempts a turn consumed or how many turns ended in
  `deterministicFallback`.

---

## 4. Fix Directions (pick during implementation)

- **A. Align prompt with validator:** make backchannel guidance explicit and
  measured ("at most two backchannels, never two real questions"), and teach the
  validator the same rule so natural speech passes on first attempt.
- **B. Best-of-2 instead of fallback:** if the retry still fails validation,
  return the *better* of the two drafts (fewest validation errors) rather than
  the robot template — a slightly imperfect persona line beats a canned one.
- **C. Tune the fact-leak check:** only flag tokens that appear in moment texts
  *and* are not in scenario/content-contract/learner text (already attempted —
  verify the `allowedText` set actually includes the compiled scenario and
  content contract; suspect it misses persona-moment lines copied from examples).
- **D. Telemetry:** add persona attempt count + validation error reasons to the
  `completion served` log so loop-heavy sessions are findable.

---

## 5. Acceptance Criteria

- [ ] Persona speech validation failure rate measurable in telemetry (attempts
      per turn, error reasons, fallback count).
- [ ] Turns that fail validation once do NOT silently become
      `deterministicFallback` when a usable draft exists (option B or equivalent).
- [ ] Prompt and validator agree on question/backchannel rules (spot-check
      against 5+ real transcripts).
- [ ] End-to-end pipeline (direction → analysis → speech → persona) stays under
      the ~4s per-request deadline even when persona retries once.
- [ ] Existing runtime tests (27+) still pass; add at least one test for
      best-of-2 selection and one for the prompt/validator backchannel alignment.

## Related

- `plans/issues_openrouter-resilience.md` — latency budget & failure policy (this
  loop is a second, *quality-driven* retry layer on top of transport retries).
- `plans/issues_chat-completions-stabilization.md` — pipeline architecture (done).
