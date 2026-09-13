# Issue: Redact Learner Names at Ingestion Time (Content & Persona Indexes)

## 1. Context

Experiment round 3 (`web/experiments/variant-option-b/`) proved that persona style/episode
examples leak past learner names into prompts. A stored example like
`"Good, good, Karthik..."` (indexed from a past transcript) bled into live sessions:

- The autonomous agent called a candidate "Harini" for 12 consecutive turns because
  `Harini` was the name in the uploaded context document / past indexed examples.
- Examples retrieved from the trainer's style store carried other learners' real names.

**Fix already shipped (validation layer):**

- `redactLearnerNames()` helper in `web/lib/persona-voice.ts` replaces any known name
  with a `<name>` placeholder.
- `createPersonaStyleMoment()` redacts at style-moment creation time (future reindexing).
- The option-b experiment handler redacts at **retrieval time** (covers the already-indexed
  corpus without a manual reindex).

**What is still missing:** redaction at **ingestion time** — when a user uploads content,
the name must be replaced *before* the text is chunked, embedded, and stored. Retrieval-time
redaction only patches what the prompt sees; the raw names still live in ChromaDB documents
and can leak through any new consumer (e.g. the show-and-tell surface, past-session retrieval,
admin search UI).

## 2. Requirements

### A. Persona source ingestion (transcripts / video analysis)

- Where: `web/lib/persona-synthesis.ts` → `ingestPersonaVoice()` and the analysis pipeline
  that produces `persona_voice_episode` / `persona_style_episode` records
  (`web/lib/persona-voice.ts`, `web/scripts/index-*.ts`).
- Before writing any `persona_voice` / `persona_voice_episode` / `persona_style_episode`
  record, redact **all** learner names present in the transcript:
  - The transcript's declared participant name (`participants.candidate` in the YAML /
    analysis metadata `pastLearnerName`).
  - Names extracted from learner turns themselves (defensive: run `extractLearnerName()`
    over every learner turn and redact each found name).
- The `<name>` placeholder must appear in BOTH the stored `text` and the `embeddingText`
  so the embedding is learner-agnostic (it already is topic-neutral; verify after change).
- Keep `usesLearnerName` metadata computed from the ORIGINAL text (current behaviour).

### B. Session context documents (uploads)

- Where: `web/lib/context-document-service.ts` chunk/manifest creation and
  `web/app/api/internal/ingestion/pump` (S3/document ingest flow).
- The candidate's own résumé/name is NOT sensitive leakage between sessions if the document
  belongs to the learner — but name extraction from documents is what fed the "Harini"
  hallucination when the document and the live speaker are different people (org-shared
  demo documents).
- On chunk creation, redact any name that matches `persona.data` / session learner name
  fields ONLY when the document is org-shared (not per-session). Decision to confirm:
  per-session documents may keep the name; org-shared seed documents must redact.

### C. Reindex sweep for existing data

- One-off script (extend `web/scripts/reindex-persona-sources.ts`) to re-chunk and re-ingest
  every existing persona source with redaction enabled, so the store can drop the
  retrieval-time patch later.

## 3. Acceptance

- [ ] New ingest of any transcript produces zero real learner names in ChromaDB documents
      (spot-check via `collection.get`).
- [ ] `bun test lib/persona-voice.test.ts` extended with a redaction-through-ingest case.
- [ ] Retrieval-time redaction in the runtime can be removed once (A) + (C) land, with a
      bench + 15-turn sim re-run showing no name bleed (`0 "Harini" leaks in 45 turns`).

## 4. References

- `web/lib/persona-voice.ts` — `redactLearnerNames()` (already exported).
- `web/experiments/variant-option-b/handler.ts` — retrieval-time redaction pattern to fold back.
- `plans/issues_persona-validation-loop.md` — style index design (Section 10).
- `plans/issues_context-grounding-hallucination.md` — related document-grounding issue.
