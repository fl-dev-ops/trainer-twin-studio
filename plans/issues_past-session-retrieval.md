# Issue: Past-Session Retrieval — Learner Memory for the Digital Twin

> **Status: DEFERRED (2026-09-12).** Do not start until the post-style speech
> flow (Section 17 of `plans/issues_persona-validation-loop.md`) is fully moved
> to production. This issue is captured now so the design intent is not lost.

## 1. Problem

The persona system gives the trainer a voice and behavioral memory drawn from
the trainer's own past conversations. It gives the trainer **no memory of this
specific learner**:

- Facts established in earlier sessions (role, projects, goals, weaknesses) are
  re-asked from scratch every session.
- Feedback given in a previous session is not referenced or followed up.
- Unresolved threads from a prior session are never resumed.

Two distinct memory problems were separated during the persona experiments
(Section 11 of `plans/issues_persona-validation-loop.md`) and only the first is
solved there:

1. **Trainer persona memory** (cross-learner behavioral examples) — solved by
   the episode/style indexes.
2. **Learner memory** (same learner, across sessions) — this issue.

The two must never be mixed: cross-learner examples are behavior evidence;
same-learner history is factual memory about the current learner.

## 2. Sketch (from the pre-session layer design)

```text
BEFORE SESSION START

Past sessions with this same learner
        │
        ▼
Learner memory pack (optional context layer)
  - established facts (role, projects, goals)
  - prior feedback given and its themes
  - unresolved threads worth resuming
  - last session's state (topic, progress, sentiment)

        │
        ▼
Injected into the session primer / session facts,
distinct from trainer-persona context
```

Candidate source: session transcripts and snapshots already persisted by the
runtime (sessions, turns, coverage, feedback). Likely storage: a
per-(persona, learner) memory collection or a structured summary table —
**decision deliberately open**; do not assume Chroma until the data shape of
past sessions is reviewed.

## 3. Constraints & open questions

- Facts must be traceable to a specific past session (source session id,
  timestamp); stale or contradicted facts need freshness/confidence handling.
- Learner identity must be resolved reliably before anything is remembered —
  what happens when the learner never states their name, or two learners share
  a name?
- Memory must be optional and degradable: a first session with a learner must
  work exactly like today.
- Privacy: learner memory is scoped to the same learner only; it must never
  leak into other learners' sessions or into trainer-persona examples.
- Update policy: when is the memory pack built — on session end (batch) or
  lazily at next session start?

## 4. Acceptance criteria (when picked up)

- [ ] Trainer references established facts and prior feedback where relevant,
      without re-interrogating them.
- [ ] No cross-learner leakage in either direction (automated check).
- [ ] First-session behavior is unchanged from the shipped post-style flow.
- [ ] Every remembered fact carries a source session reference.
- [ ] 30-turn simulation includes a returning learner with prior history.

## Related

- `plans/issues_persona-validation-loop.md` — Sections 11 and 17 define the
  pre-session layer this issue plugs into.
- `plans/issues_context-grounding-hallucination.md` — current-session fact
  grounding; learner memory extends it across sessions.
