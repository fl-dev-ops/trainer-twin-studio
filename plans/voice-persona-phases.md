# Voice and persona — two-phase plan

Status: Voice phase implemented and locally verified, 19 November 2026. Persona phase implemented and locally verified, 19 November 2026.
Grounding: `persona-research.md`, the current Prisma schema, persona editor/media helpers and TTS routes.

## Product decisions

- Voice is a reusable building block, referenced by Persona. No VoiceVersion model.
- Persona describes the person and their stable behavior, not the roleplay or learner.
- Agents reference personas; selecting either a voice or persona does not copy its content.
- Do not add a new persona versioning/publishing system in these phases. Preserve existing history.
- Freeze the resolved persona configuration for each session; library edits apply to new sessions.
- Few meaningful controls, explicit Save/Cancel, no advanced panel hiding a second configuration product.
- All implementation rehearsals and data changes remain local. No production migrations, provider
  asset mutation, deployment, original-checkout changes or Vasanth roleplay conversion.

## User-facing scope

### Voice

Two simple actions:

1. **Choose a voice:** a compact picker with names and Listen, showing allowed ready voices.
2. **Add my voice:** a name and one recording/upload, using the existing capture/cloning flow.

Use the existing recording passage/transcript where available. Do not introduce a mandatory transcript
field or a new transcription service. Any existing upload path that needs reference text must retain
its functional input rather than silently dropping it.

No user controls for model, provider, stability, similarity, speed, pitch, emotion or versions.
No new voice-generation feature. Keep existing sample voices and organization voices; do not build a
new catalog, recommendation engine or taxonomy.

### Persona

One short form:

| Field | Behavior |
| --- | --- |
| Name | Required |
| Role | Required short text; examples such as Buyer, Interviewer or Coach, not a long role taxonomy |
| About this person | Optional short description of relevant background and stable behavior |
| Voice | Compact picker with Listen; preserve the current selection when editing |
| Photo | Optional upload; initials when absent |

Defaults: plain professional language, concise natural answers, normal pace and no forced fillers,
theatrical pauses or scripted interruption mannerisms. A scenario may require different response
behavior; persona defaults must not override its rules.

Do not expose age, location, multiple personality tags, opening-style choices, formality sliders,
answer-length menus, interruptions, fillers, pauses, signature-phrase lists or pace controls.
Use the description for meaningful distinctions instead of adding another switch.

New fictional personas can use an existing approved sample default if configured. Never silently
replace a real trainer's voice or guess identity facts. If no suitable voice exists, keep text use
available and make the voice prerequisite clear before starting a voice session.

Existing hidden fields, avatars/videos and source-derived trainer behavior remain preserved.
Simplifying the form does not authorize resetting fields that the new form does not edit.

## Phase 1 — reusable voice references

### Outcome

One Voice record can be selected by multiple permitted personas without creating additional Voice rows
or copying reference audio/transcript files.

### Backend and database

1. Retain `Voice` identity, organization, name, kind, status and audio/transcript object references.
   Retain `Persona.voiceId`, but replace its unique relationship with many-personas-to-one-voice.
   Do not change Avatar ownership as part of this phase.
2. Update the Prisma reverse relation, unique index, database triggers and all callers together.
   Current enforcement is in `20261028020000_persona_media/migration.sql`; removing the Prisma
   `@unique` alone is insufficient.
3. Centralize eligibility: same-organization ready voices plus explicitly allowed global sample voices.
   A global sample is read-only to organization users. No cross-organization cloned-voice access.
   Enforce this for listing, attaching, previewing and runtime resolution, not only in the picker.
4. Replace `setPersonaVoiceFrom`'s copy behavior with validated ID attachment. Selecting another
   voice must not rename, overwrite or delete the previous shared voice or its files.
5. Recording/upload creates a standalone Voice through the existing pipeline, then attaches its ID.
   Do not expose a ready/selectable voice with an empty or failed audio reference.
6. Preserve existing rename and preview capabilities. Block deletion while a voice is in use,
   including relevant saved-session references; do not silently null another persona's selection.
   No automatic asset cleanup or deduplication in this migration.
7. Keep the TTS resolver contract compatible. Its existing `version: updatedAt` field is a cache
   invalidation token, not voice-version history; do not remove it merely because Voice is unversioned.
8. Editing/replacing a shared voice's reference recording in place is outside this phase.
   To use another recording, add/select another Voice resource; this is not a version chain.

### Local migration

- Inventory current voices, persona links and storage ownership before applying anything.
- Apply explicit migrations only to the isolated local target.
- Keep existing Voice IDs, Persona IDs, attachments and object keys.
- Existing duplicated voices remain separate records; no automatic merging by name or audio similarity.
- Do not copy files merely to change attachment semantics.
- Verify counts and checksums before/after; rerunning checks must not add records or objects.

### Primary touchpoints

- `web/prisma/schema.prisma` and a new scoped migration.
- `web/lib/persona-media.ts`, voice eligibility helpers and relevant persona mutation routes.
- `web/app/api/tts/voices/route.ts`, `[voiceId]/route.ts`, speech/default-voice consumers.
- `web/components/voice-library.tsx`, persona voice selection and trainer voice capture.
- All ownership/relation consumers discovered with a repository-wide caller search before editing.

### Acceptance gate

- Attach one voice to two personas: same Voice ID, unchanged Voice/object counts.
- Switch one persona's voice: the other persona and its playback remain unchanged.
- Re-selecting the current voice is idempotent; concurrent attach/delete cannot create a dangling link.
- Another organization's voice is refused; ready global samples can be referenced but not modified.
- Failed/missing uploads cannot become selectable; in-use deletion is refused without removing files.
- Existing Olga voices, trainer capture and TTS resolution continue to work.
- Typecheck, focused unit/database tests and a real local playback check pass.
  Restart local voice infrastructure only when needed for that check; no production voice assets.

Stop and verify this phase before starting Persona work.

### Voice implementation checkpoint

- Work is scoped to reusable voices, voice access/deletion safety, selection/upload controls and runtime voice references.
- Isolated application target: `trainertwin_olga_local`; regression target: `trainertwin_shared_skills_test`.
  Migration commands must pass their destination explicitly; never target the source `trainertwin` database.
- Before changes: local backup saved privately; baseline covers ten Voices, ten Personas, ten Avatars,
  12 Agents, 23 SpecVersions and SHA-256 hashes for 19 voice audio/transcript objects.
- `web/scripts/check-shared-voices-local.ts --check` must verify these original records and bytes after testing.
- A nullable `InterviewSession.resolvedVoiceId` foreign key records the selected voice for new voice calls.
  This is an attachment/reference, not versioning. It protects referenced voices from concurrent deletion.
  Missing historical selections must not be backfilled from a persona's present-day voice.
- Shared selection attaches an existing ID. Upload creates a standalone resource, persists its reference keys
  before object writes, and becomes ready only after successful storage. Incomplete removal retains an immutable,
  nonselectable `deleting` record with an owner-visible retry action.
- Own-persona selection retires legacy copied twin overrides atomically while preserving spec/skill history.
  Role-play overrides, avatar ownership/files, old voices and existing session pins remain unchanged.
- Cross-mode/foreign-user resumes are refused before token, allowance or voice mutation. Legacy NULL pins resolve
  once on voice connection without claiming that today's compatibility selection was the original historical voice.
- The forward `20261119220000_chat_voice_snapshots` migration preserves missing/failed voice IDs in historical
  chat snapshots without granting voice access. Active attachments, voice snapshots and native pins stay strict;
  new historical references cannot race deletion.
- Both voice migrations are applied to the explicitly named regression, migration-rehearsal and Olga-local
  databases. The full initial migration replay and subsequent forward migration succeeded.
- Preservation audits passed: all original baseline records and 19 voice files match; Olga verification still
  covers 12 experiences, 16 mappings, 11 current packages and 147 twin examples. Four historical Objection Handling
  versions remain unavailable because eight original embedding inputs are missing; nothing was invented or converted.
- Verified: 82 focused Postgres tests, all 1,075 database regressions, 104 focused unit/UI tests,
  1,283 offline unit tests, 150 full application flows and 62 TTS proxy tests pass. Scoped lint has no errors and three existing
  unused-import warnings in `web/lib/specs.ts`. Typecheck passes after native Next route-type generation.
- Chromium verification passes all seven voice flows plus authentication setup: real API/local-S3 sharing,
  selection, playback transport, byte-identical upload, explicit Save/Cancel, attachment retry, rename,
  in-use protection and retryable removal. Inference for local-only voices is explicitly synthetic.
- The isolated build compiles, typechecks and prerenders all 63 static pages successfully, but exits with
  `SecurityFatalError` for the existing Next.js 16.4.3 advisory. No security check was disabled and no
  dependency was upgraded. This remains a separate dependency-maintenance gate, not a passing build claim.
- The earlier unfiltered unit run had two unrelated live-model assertion failures (document retrieval/deictic
  wording). Offline verification excludes the three `*e2e.test.ts` runtime files and `runtime-stream.test.ts`,
  which make unmocked model requests. Their assertions were not weakened or reclassified as passing.
- One broad run hit an existing assignment-restore race returning `not_found` rather than `person_is_studio`.
  The final complete database run passed without changing that assertion or the assignment implementation.
- The user explicitly approved `tts.trainertwin.com` for inference and its normal cache activity:
  three local-Studio requests using two original Olga IDs produced two WAV responses and one streamed PCM
  response, all non-silent. New local-only IDs are unknown to the production resolver; their full API/S3/browser
  transport uses an explicitly synthetic inference fixture, not a claim of real cloning.
- Test gotchas: use Prisma query extensions for database fault injection because delegate-level spies do not
  reliably intercept the client proxy. Verify real uploaded bytes/MIME through local S3; browser protocol request
  bodies may omit file parts. The isolated browser server restores generated tracked files even after startup failure.
- Next.js reports an existing security advisory; no dependency upgrade, production application-data writes,
  production migrations, deployment, push, Persona redesign or Vasanth conversion is authorized by this phase.
- Temporary browser/provider test services are stopped. Local Studio, chat, S3, Chroma and the shared proxy remain
  available; the three original Olga chat sessions retain NULL voice pins rather than invented historical selections.

## Phase 2 — reusable persona with a small editor

### Outcome

A persona has one reusable definition and voice reference, edited through the short form above.
The same persona can serve different agents without receiving their scenario rules or learner data.

### Definition and ownership

- Keep first-class identity/organization, existing `isOwn`, voice and avatar references.
- Keep behavior as validated persona data rather than creating tables for each trait.
- Persist Role and the short About description as canonical editable values; do not add an LLM call
  merely to extract dozens of hidden traits from a short form.
- Preserve existing structured traits, legacy trainer data and source provenance. Update only fields
  the user actually edits; never regenerate an entire real trainer definition on a basic Save.
- Do not expose an `isOwn` toggle or a fictional/real-person configuration wizard. Existing trainer
  capture and ordinary persona creation already establish those distinct flows.
- Preserve current Agent-to-Persona links. No content duplication on selection.
- Keep existing avatar behavior and files. Avatar sharing/video generation is not a third phase here.

### Explicit boundaries

| Owner | Content |
| --- | --- |
| Persona | Identity, stable description/style/preferences, voice and avatar references |
| Agent/skill/roleplay | Scenario facts, starting mood, objectives, difficulty, stages, question rules and knowledge access |
| Session | Learner data, conversation history, current emotion/rapport and collected evidence |
| Evaluation | Rubric, scores and reports |

Do not automatically rewrite old backgrounds that mix persona and scenario facts. Preserve and flag
them during inventory; moving authored content between entities needs an explicit content decision.
Do not move skill-owned trainer behavior or question examples into Persona.

### Editor and runtime

1. Replace the current Look/Talk/Media configuration surface with the single short form.
   Save/Cancel commits or discards the whole form; previewing a voice does not save it.
   Preview remains useful feedback, not another settings screen.
2. Show a compact "Used by N agents" indicator so shared edits have an understandable impact.
   Block removal while an agent uses the persona; no automatic detach or learner-facing fallback.
3. Build a consistent runtime persona brief from the saved definition. Preserve the distinction between
   fictional character behavior and the existing trainer/self path; do not apply a buyer personality to Olga.
4. Resolve persona data and voice selection once when a session starts and save it in the existing
   compiled snapshot. Chat, voice and resumed-session context must read that snapshot.
   Do not persist expiring signed URLs as the canonical reference.
5. Persona edits affect later sessions, not the next reply of an active session.
   A voice switch on Persona does not switch an already-started session.
6. Retain existing Persona version counters, SpecVersion history and old-session compatibility.
   Add no PersonaVersion table, version picker, draft/publish UI or rollback feature in this scope.
   If a historical configuration is missing, surface that limitation rather than claiming it is frozen.

### Primary touchpoints

- `web/lib/persona.ts`, persona create/update and trainer-capture paths.
- `web/components/persona/persona-editor.tsx`, detail/library views and voice attachment UI.
- `web/lib/specs.ts`, `web/lib/interview-sessions.ts`, session-context and chat instruction composition.
- Python voice dispatch/context resolution where persona/voice is consumed.
- Source/history readers and round-trip compatibility tests for non-editor-shaped trainer data.

### Acceptance gate

- The create/edit form contains only the five fields above, with no advanced settings panel.
- Creating/saving does not require selecting personality tags or filling hidden fields.
- One persona works with two different roleplays; scenario facts and learner state do not leak between them.
- Start session A, edit the persona, start session B: A retains its definition and voice selection;
  B uses the updated definition. Verify across multiple chat turns and voice dispatch.
- A simple edit leaves hidden legacy fields, source records, history and existing media intact.
- Olga's trainer persona and a synthetic interviewer-shaped fixture both round-trip correctly.
  Do not port or convert Vasanth's real roleplays to run this test.
- Description text cannot grant tools, bypass access controls or reveal hidden evaluation content.
- Database/agent regression tests, typecheck, focused lint and local end-to-end checks pass.
  Report the known Next.js security build gate and browser-certificate prerequisite honestly if unresolved.

### Persona implementation checkpoint

- One short form replaces the Look / How they talk / Voice and avatar tabs: Name, Role (free text with suggestions),
  About (optional, stored as `Persona.data.background`), Voice and optional Photo. One Save commits the definition and
  voice selection in a single transaction; Cancel discards. Choosing or previewing a voice saves nothing; a photo is
  uploaded after the definition saves and a failure says so. The avatar video upload left the editor; stored videos stay.
- Saves replace only `name`, `role`, `background`. Every other stored key (older editor traits, a trainer's recorded
  style, source evidence, `difficulty`/`knowledge`, settings, avatar) is kept; an unchanged save makes no SpecVersion.
  Earlier editor traits are shown read-only as "Earlier settings" and still drive the brief. No new tables or migrations.
- Brief: short-form characters get plain defaults (no fillers/pauses/interruptions); older-editor characters keep their
  lines; the trainer's own persona stays identity-only. A recorded style/decision-preferences profile is carried in the
  brief once a role exists (as chat's legacy line did), so the interviewer shape round-trips. Every brief states that
  the description never changes instructions, tools, access or evaluation; scenario/skill wins on conflict.
- Own-persona voice changes still go through `selectOwnPersonaVoice` (twin override retirement) in the same transaction.
- "Used by N agents" on the editor, page and cards. Removal is refused (409) while any agent, archived included, uses the
  persona, checked under a row lock before history or files are touched (previously a raw FK error after deletions).
- Sessions already froze `compiledSnapshot.persona` and `resolvedVoiceId` at start; tests now prove A keeps both across
  turns and reconnects while B gets the edit.
- Verified on 19 Nov: new persona DB suite 10/10; full DB suite 1,084 pass / 1 unrelated ordering flake
  (`org-people` member order, passes 3/3 standalone); offline unit 1,287/1,287; flows 150/150; chat 125/125;
  component tests 85/85 (parallel); Chromium voice/persona specs 9/9 with real API and local S3 (synthetic inference);
  typecheck, touched-file lint (3 existing `specs.ts` warnings) and `next build` pass.
- Not verified: real-model multi-turn chat and a real LiveKit voice call after a persona edit (dispatch is asserted with
  LiveKit mocked), and a visual pass on the Olga local copy. No production writes, pushes or Vasanth conversion.

## Completion and exclusions

Each phase ends with a local-only migration audit, behavioral verification and a concise checkpoint.
No push/deployment or production migration is implied.

Not included: voice versioning, a new persona version system, large preset catalogs, trait generation,
provider/model controls, shared avatars, new voice-generation services, content-wide deduplication,
learner-memory redesign or Vasanth roleplay conversion.

Decision summary: **Voice = choose or add. Persona = name, role, description, voice, optional photo.**
