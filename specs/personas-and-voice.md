# Personas and voice

> A persona is the reusable person the AI speaks as: the trainer themselves, or a character a learner practises with. It holds identity and speaking style, a voice reference, an avatar, and program settings. This module builds personas from forms or source material, stores their media, and supplies a voice ID to sessions. It does not own the scenario's knowledge, difficulty, or session lifecycle.

## Who uses it

| Who | What they can do here | Code |
| --- | --- | --- |
| Org admin and team | Create and edit personas, upload and analyze sources, inspect the baseline, set media, and capture their own voice/photo. Both roles have the same studio access. | `web/lib/org.ts` `getTrainerOrg`; `web/lib/trpc.ts` `studioProcedure`; persona routes below |
| Any enabled org member, including a learner | List shared/org voices, upload a cloned voice, rename/delete their org's cloned voices, and view their org's persona photos. These REST routes do not require a studio role. | `web/app/api/tts/voices/route.ts`; `web/app/api/tts/voices/[voiceId]/route.ts` PATCH/DELETE; `web/app/api/personas/[slug]/avatar/route.ts` |
| Voice agent | Receives the selected voice ID in LiveKit metadata. Its configured TTS provider decides whether to use that ID. | `web/lib/session-activation.ts` `activateInterviewRuntime`; `agent/src/agent.py`; `agent/src/tts/__init__.py` |
| TTS service | Resolves a voice ID to a signed audio URL and transcript using a shared secret. | `web/app/api/tts/voices/[voiceId]/route.ts` GET |
| Operators | Seed samples/preset personas and reindex stored behavioral analyses. | `web/prisma/seed-voices.ts`; `web/scripts/seed-persona-presets.ts`; `web/scripts/reindex-persona-sources.ts` |

Persona pages require a studio member and redirect twin-only orgs to `/twin`; the persona REST routes do not check the `hideRoleplay` flag (`web/app/dash/personas/layout.tsx`; `web/lib/org.ts` `requireRoleplayOrg`; `web/app/api/personas/route.ts`). See [Organizations and roles](orgs-and-roles.md) for membership selection.

## Words used here

| Term | Meaning |
| --- | --- |
| Own persona (`isOwn: true`) | A real trainer's reusable identity, recorded style, and media. Twins must use an own persona. It is not a per-user singleton. |
| Other persona (`isOwn: false`) | A character, including role-play clients, interviewers, coaches, and global presets. A role play may also use an own persona. |
| Global/shared | A row with `orgId: null`, not a row belonging to another org. |
| Source (`PersonaSource`) | One raw video, audio file, document, transcript, or chat export used to extract behavioral evidence. |
| Voice moment | Searchable wording/action evidence from an analysis. This is text in the vector index, **not** cloned audio. |
| Synthesis | Combining source analyses into persona YAML: style, language, decision preferences, calibration, and examples. |
| Baseline | A read-only view of extracted persona fields plus measured corpus statistics. |
| Voice (`Voice`) | An opaque ID pointing to reference audio and an optional transcript for speech generation. `sample` and `cloned` are library kinds. |
| Avatar (`Avatar`) | A persona-owned image/video record. The display image can differ from the original captured photo. |
| TTS | Text-to-speech: generating spoken audio from text, optionally using reference audio. |
| Program setting | A value outside prompt data, currently `settings.pace`. Saving it does not mean the speech engine applies it. |

Definitions come from `web/lib/persona.ts`, `web/lib/persona-voice.ts`, `web/lib/persona-synthesis.ts`, `web/lib/persona-baseline.ts`, and `web/prisma/schema.prisma` (`Persona`, `PersonaSource`, `Voice`, `Avatar`).

## Data

### Owned records

| Record | Fields and writers |
| --- | --- |
| `Persona` | `id` is the immutable reference identity; `slug` is unique within org, including the global scope; `name`, numeric `version` (starts at 1), `data` JSON, immutable `isOwn`, nullable unique `voiceId`/`avatarId`, nullable object `settings`, timestamps. Form saves write prompt fields/settings; YAML saves and synthesis write `data`; media helpers write the links. |
| `PersonaSource` | `personaId`, required `orgId`, original filename `name`, `kind`, S3 `s3Key`, `status`, nullable analysis JSON, metadata (`size`, `mimeType`, `analysisAttempts`, `error`, `voiceMoments`, `voiceActions`), timestamps. Upload, queue, analyzer, and reindex scripts write it. Deleting a persona cascades its source rows. |
| `Voice` | `id`, nullable `orgId`, non-unique `name`, string `kind` (default `cloned`, also `sample`), string `status` (default `ready`, comment also lists `failed`), required `s3AudioKey`, optional `s3TranscriptKey`, timestamps. No enum or automatic training-status lifecycle. Uploads save references, not trained model weights. |
| `Avatar` | `id`, nullable `orgId`, `name`, optional `s3ImageKey`, `s3OriginalImageKey`, `s3VideoKey`, timestamps. Media helpers and Twin capture write it. |
| `SpecVersion` (shared) | Previous persona `data`, keyed by org/type/slug/version. It does not snapshot media or `settings`. See [Role plays](roleplays.md) for the shared spec machinery. |

Pointers: `web/prisma/schema.prisma`; `web/prisma/migrations/20261027000000_split_twin_roleplay/migration.sql`; `web/prisma/migrations/20261028020000_persona_media/migration.sql`; `web/lib/personas.ts` `savePersona`; `web/lib/specs.ts` `saveSpec`; `web/lib/persona-media.ts`; `web/lib/twin/avatar.ts`.

A persona owns at most one voice and one avatar; neither can be linked to a second persona. Their orgs must match the persona's org (including both being global). Deleting either media row clears the persona's link. Agents reference a persona with `onDelete: Restrict` (`web/prisma/schema.prisma`; the two migrations above).

### Form fields

The strict input schema rejects unknown keys. All strings below are trimmed. Stored names differ from form names where shown (`web/lib/persona.ts` `personaInputSchema`, `storedFromPersona`).

| Form → stored field | Accepted value |
| --- | --- |
| `name` → `data.name` and row name | 1–120 characters |
| `role` → `data.role` | 1–60 characters; not restricted to the UI role list |
| `age` → `data.age` | Integer 18–100 or null; null is omitted in stored data |
| `basedIn` → `data.based_in` | Up to 120 characters |
| `background` → `data.background` | Up to 2,000 characters |
| `behaviours` | 1–3 entries from Warm & Open, Warm but Cautious, Curious & Probing, Skeptical & Reserved, Direct & Challenging |
| `openingStyle` → `data.opening_style` | `friendly`, `skeptical`, `rushed` |
| `formality` → `data.mannerisms.formality` | `casual`, `neutral`, `formal` |
| `answerLength` → `data.mannerisms.answer_length` | `short` (few words/one sentence), `medium` (one/two), `long` (three/four) |
| `interrupts` → `data.mannerisms.interrupts` | `never`, `sometimes`, `often` |
| `pauses`, `fillers` → `data.mannerisms` | Booleans |
| `phrases` → `data.signature_phrases` | At most 4 nonempty strings, each at most 200 characters |
| `howTheyTalk` → `data.how_they_talk` | Up to 2,000 characters |
| `pace` → `settings.pace` | `slow`, `normal`, `fast` |

The UI groups roles into clients (Buyer, Seller, Landlord, Investor, Prospect, Tenant), interviewers (Technical interviewer, Senior engineer, Engineering manager, Hiring manager), and coaches (Sales coach, Sales manager, Mentor, Senior agent). Stored legacy values are read tolerantly, with defaults and capped lists. Form saves preserve unknown existing top-level data but remove `difficulty` and `knowledge`; these belong to the role play (`web/lib/persona.ts` `PERSONA_ROLES`, `personaFromStored`, `storedFromPersona`).

Own personas can also carry `style`, `language`, `decision_preferences`, `calibration`, `examples`, and `source_evidence` from synthesis. This YAML path does not use the strict form schema (`web/lib/persona-synthesis.ts` `synthesizePersona`; `web/lib/specs.ts` `saveSpec`).

### Lifecycles

- Source: `uploaded` (queued) → `analyzing` → `analyzed`; automatic compilation temporarily uses `compiling` → `analyzed`. Analysis/indexing errors → `failed`. Explicit retry → `uploaded`; stale active work → `uploaded` after 15 minutes. `analyzed` with zero moments is not complete for enqueue purposes (`web/lib/persona-analysis-queue.ts`; `web/lib/persona-synthesis.ts`).
- Persona: create version 1 → versioned edits. There is no persona draft/publish status here. Media/settings helper updates do not bump the persona version (`web/lib/personas.ts`; `web/lib/specs.ts`; `web/lib/persona-media.ts`).
- Voice: created `ready` by default; persona reference uploads explicitly set `ready`. The inspected upload paths do not transition to `failed` on storage or speech failure (`web/prisma/schema.prisma` `Voice`; voice POST route; `web/lib/persona-media.ts` `setPersonaVoice`).

## How it works

### Create, edit, and use a persona

1. The library lists the org's personas, own first and then by name. It does not list global rows (`web/lib/personas.ts` `listPersonas`).
2. Form creation makes an **other** persona at version 1. Slugs come from normalized names, capped at 60 characters, with `-2`, `-3`, etc. on collisions. Editing keeps the slug and `isOwn`, snapshots old data, and always increments the version, even for unchanged input. Own personas can be edited through the same save helper without losing recorded style (`web/lib/personas.ts` `savePersona`; `web/lib/persona.ts` `slugify`).
3. The advanced spec route accepts YAML containing a `persona` section. Creating through `saveSpec` makes an **own** persona. Changed JSON snapshots the old version; identical JSON does not bump it. This is a different validation path from the form (`web/lib/specs.ts` `saveSpec`; `web/app/api/spec/[type]/[[...id]]/route.ts` PUT).
4. A session pins persona data/version in its compiled snapshot. Session context renders `personaBrief` from that data: an own persona gets identity/background only; a character gets meanings for manner/behavior options, phrases, and the rule that persona controls manner while scenario/skill controls content. No role means no brief, allowing the chat's legacy style/preferences fallback. Pace/media are not rendered (`web/lib/interview-sessions.ts`; `web/lib/session-context.ts` `buildSessionContext`; `web/lib/persona.ts` `personaBrief`; `chat/agent/lib/brain.ts` `personaLines`; `chat/agent/lib/roleplay.ts`). See [Sessions](sessions.md) and [Voice agent and chat](voice-agent-and-chat.md).

### Sources, queue, and synthesis

1. Upload requires a `file` and an org-owned persona. A row is created with `s3Key: "pending"`, bytes are stored under the persona/source prefix, then the real key is saved. MIME and extension determine kind: media first, document extensions next, JSON/CSV as chat, everything else as transcript (`web/app/api/personas/[slug]/sources/route.ts`; `web/lib/persona-synthesis.ts` `uploadPersonaSource`, `detectKind`; `web/lib/s3.ts` `personaSourcePrefix`).
2. The upload route schedules a queue drain with Next.js `after()`. The ingestion pump also drains it, on the configured two-minute cron. Uploaded rows are the queue; the claim query takes the oldest using `FOR UPDATE SKIP LOCKED`, checks for fresh active work, increments attempts, and removes the previous error (`web/lib/persona-analysis-queue.ts` `claimNextPersonaSource`, `drainPersonaAnalysisQueue`; `web/app/api/internal/ingestion/pump/route.ts`; `web/vercel.json`).
3. Existing analysis with usable moments is reindexed without another model call. Otherwise video/audio goes through Gemini Files and `gemini-2.5-flash`; documents become markdown before text analysis; transcript/chat bytes are decoded as text. Text analysis uses the AI gateway/OpenRouter-compatible endpoint and `PERSONA_ANALYSIS_MODEL` (default `google/gemini-2.5-flash`). Missing media credentials, provider failures, JSON failures, or indexing errors mark the source failed with an error (`web/lib/persona-synthesis.ts` `analyzePersonaSource`, `uploadToGeminiFiles`, `analyzeWithText`, `analyzeWithMedia`).
4. Extract paired responses first, then behavioral examples, then verbatim phrases; deduplicate responses case-insensitively. Search text uses interviewer wording (capped at 400 characters); candidate context is separate metadata (200 characters). Store moments with source/persona IDs in the org's main vector collection. Reingestion deletes that source/type's prior moments before upserting (`web/lib/persona-voice.ts` `extractPersonaVoiceMoments`; `web/lib/main-collection.ts` `ingestPersonaVoice`). See [Knowledge](knowledge.md) for the vector-store boundary.
5. When **every** source is analyzed, only the most recently completed triggering source automatically compiles the settled corpus. Synthesis consumes analyzed/compiling analyses in creation order, asks for cross-source style rather than source facts, strips markdown fences, and passes YAML to `saveSpec`. An automatic synthesis/save error is logged, not surfaced as an analysis failure; the trigger returns to analyzed (`web/lib/persona-voice.ts` `shouldRebuildPersona`; `web/lib/persona-synthesis.ts` `rebuildPersonaIfCorpusReady`, `synthesizePersona`).
6. Manual synthesis returns `{ ok, yaml }` without saving. No analyzed sources is a 400. Deleting a source removes raw storage and searchable moments, deletes its row, then attempts a rebuild of any settled remaining corpus (`web/app/api/personas/[slug]/synthesize/route.ts`; `web/lib/persona-synthesis.ts` `deletePersonaSource`).
7. The source panel uploads bulk files sequentially, reports partial upload failures, polls every three seconds only while analyzing/compiling, and offers retry/index actions. Coverage is high at 50 moments and 6 distinct actions, medium at 20 and 3, otherwise low; low coverage is not a session gate (`web/components/persona-source-panel.tsx`; `web/lib/persona-voice.ts` `personaCoverageLevel`).

### Baseline

`getPersonaBaseline` reads the current org persona, even when the spec page shows a historical version. It returns provenance, tone/habits/avoidances, language samples, state→decision rows with example counts/first sample, and calibration values. Missing fields become null/empty lists. Corpus statistics failure produces a null fingerprint rather than failing the page (`web/lib/persona-baseline.ts`; `web/lib/pages/spec-resource.ts` `loadSpecResource`).

The fingerprint measures learner-name use, doubled acknowledgments, thanks at turn start, average spoken words, and questions. It reads up to 1,200 `persona_voice_episode` records and caches stats in process; ordinary uploaded `persona_voice` moments alone do not produce it. The baseline distinguishes extracted prose from runtime measurements. The deterministic runtime has `compareStyleRates` and `selectAction`; this is not proof that every chat/session mode enforces every extracted field (`web/lib/main-collection.ts` `getPersonaPrimerStats`; `web/components/persona-baseline-panel.tsx`; `web/lib/runtime/runtime.ts`; see [Voice agent and chat](voice-agent-and-chat.md)).

### Media, avatars, and headshots

- A saved other persona's media form can choose a library voice or upload audio, image, and/or video. Own personas receive 404 here and use Twin's brain instead. A supplied `voiceId` wins over supplied audio (`web/app/api/personas/[slug]/media/route.ts`).
- Pickable voices are ready, unowned global samples or the org's unowned clones. Choosing one **copies** its reference audio/transcript into the persona's own cloned voice and copies the name; it does not share the sample/library row (`web/lib/persona-media.ts` `pickableVoices`, `setPersonaVoiceFrom`).
- Voice/avatar helpers create a linked row on first use. Replacement writes unique storage keys before switching the record, then best-effort deletes replaced files. A first-link race returns 409 and cleans up its losing row/files. Updating just image or video preserves the other (`web/lib/persona-media.ts` `setPersonaVoice`, `setPersonaAvatar`).
- Twin photo capture keeps the original JPEG and either displays it or a chosen generated headshot. Four style choices call the image gateway (`AVATAR_IMAGE_MODEL`, default `google/gemini-3.1-flash-image`), store temporary candidates, and return one-hour URLs. Saving accepts only this avatar's candidate path, copies the choice, and best-effort clears candidates/replaced images. A missing candidate asks the user to choose again; headshot generation failure returns a friendly error (`web/lib/headshot.ts`; `web/lib/twin/avatar.ts` `makeHeadshot`, `saveAvatar`; `web/lib/twin/trpc.ts` `avatarRouter`).
- Media helpers return signed URLs and inline voice transcript; malformed settings fall back to normal pace. Avatar-photo GET redirects enabled org members to a one-hour S3 URL, with private 3,000-second cache. Session-facing `agentPhotoUrls` instead returns six-hour signed URLs so share-link learners need not be org members (`web/lib/persona-media.ts` `getPersonaMedia`, `agentPhotoUrls`; `web/app/api/personas/[slug]/avatar/route.ts`; `web/lib/twin/avatar.ts` `avatarPhotoUrl`). Storage/presigning details: see [Platform](platform.md).

### Voice cloning

1. `/voice/cloning` picks one of five English passages; switching excludes the current one. The recorder requires microphone permission, allows finish after 10 seconds, targets 20, and stops at 30. Browser audio is converted to mono 16-bit WAV with one second of trailing silence (`web/app/dash/voice/cloning/cloning.tsx`; `web/components/voice-recorder.tsx`; `web/lib/voice-passage.ts`; `web/lib/wav.ts` `recordingToWav`).
2. POST the audio plus passage transcript to `/api/tts/voices`. The server saves reference bytes and optional transcript, returns a ready cloned row, and the page opens its TTS playground. No model training or verification job runs at upload. Upload/network errors are shown and can be retried (`web/app/api/tts/voices/route.ts`; cloning page above).
3. Twin's `/twin/brain/voice` captures audio and video of the same take, offers review/re-record, uploads video directly to a signed S3 URL, uploads the WAV/transcript via the same voice route, then calls `twin.avatar.saveVoice` (`web/components/twin/twin-voice-capture.tsx`).
4. `savePersonaVoice` selects the main twin's own persona, falling back to the oldest own persona. It requires a ready voice in the same org, unowned or already owned by that persona, and a correctly shaped video key in that avatar's folder. It links the voice and video transactionally and removes copied `data.voiceId` overrides from all that persona's TWIN agents, versioning those agent edits. Replaced video is removed best-effort; a previous voice is deleted only if no persona owns it and no org agent names it (`web/lib/twin/avatar.ts` `ownTwinPersona`, `savePersonaVoice`, `removeUnusedVoice`). See [Twins](twins.md) for setup ownership.

### Session voice selection and TTS

1. Chat-only activation skips voice selection. Voice activation chooses a nonempty string `agent.data.voiceId` override, otherwise the current linked persona's `voiceId`. The chosen ID must be ready and belong to the org or be global. If unavailable, use the alphabetically first ready global voice; an invalid override does **not** retry the persona voice. If none exists, pass no voice. This reads live agent/media rows, not the pinned prompt snapshot (`web/lib/session-activation.ts` `activateInterviewRuntime`).
2. The ID travels through LiveKit metadata to `build_tts(voice=...)`. The **default provider is Sarvam**, using `en-IN`, `SARVAM_TTS_MODEL` (default `bulbul:v3`), and `SARVAM_SPEAKER` (default `rohan`). This branch ignores the persona's cloned voice ID. A non-`sarvam` `TTS_PROVIDER` selects the VoxCPM2 path (`web/lib/livekit.ts`; `agent/src/agent.py`; `agent/src/session.py`; `agent/src/tts/__init__.py`).
3. VoxCPM2 uses the supplied ID, otherwise `AGENT_VOICE_ID_OVERRIDE`, `AGENT_DEFAULT_VOICE_ID`, then `VOXCPM_VOICE`. Its endpoint is `VOXCPM2_ENDPOINT`, `TTS_SERVICE_URL`, or the web speech proxy. It requests streaming PCM. An unknown-voice 404 retries with `AGENT_FALLBACK_VOICE_ID` (default `charlotte-sample`) and retains that fallback for the session; other errors still raise (`agent/src/tts/voxcpm2.py`).
4. The browser proxy forwards JSON to the TTS service with defaults `model: voxcpm2`, PCM, and streaming (caller fields can override these). `TTS_SERVICE_KEY` stays server-side. Missing service URL gives 500; upstream errors propagate; successful audio streams through with sample-rate headers (`web/app/api/tts/speech/route.ts`).
5. The Python TTS service resolves the ID through web GET `/api/tts/voices/{id}` using `APP_API_KEY` matching web's `TTS_APP_KEY`. Web returns a ten-minute audio URL, trimmed transcript/null, and `updatedAt` version. It does not check org or voice status; possession of the shared secret is the authorization boundary (`tts/app/voices.py`; web resolver route).
6. TTS metadata is cached for 300 seconds by default, with stale-cache fallback when web is unreachable/non-200 except 404. It sends `ref_audio` and optional `ref_text` to vLLM-Omni, default `openbmb/VoxCPM2`, and chunks text sequentially (default target ~11 seconds, max target ~15). Streaming emits mono 16-bit PCM at configured rate (default 48 kHz); nonstreaming returns WAV or PCM (`tts/app/config.py`; `tts/app/main.py` `speech`, `build_payload`; `tts/app/voices.py` `VoiceStore`).

## Rules

1. `isOwn` cannot change, a global persona cannot be own, and a TWIN agent cannot use an other persona. Agents may use same-org or global personas, not another org's (`web/prisma/migrations/20261027000000_split_twin_roleplay/migration.sql`).
2. Persona form writes require admin/team: unauthorized callers receive 403. Source/synthesis/spec routes require the same roles but return 401 when the org helper fails. Org-owned lookups prevent editing another org's persona (`web/app/api/personas/route.ts`; `[slug]/route.ts`; source/synthesis routes; `web/app/api/spec/[type]/[[...id]]/route.ts`; `web/lib/personas.ts`).
3. Form input must satisfy the field table above; unknown keys, including difficulty/knowledge, fail with 400. Free-text roles are allowed; duplicate behaviors/phrases are not explicitly rejected (`web/lib/persona.ts` `personaInputSchema`; `web/lib/personas.ts` `savePersona`).
4. Enqueue is a no-op for analyzing, compiling, or analyzed-with-positive-moments sources. Failed sources at 3+ attempts reset their counter on explicit enqueue. There is **no** enforced three-attempt ceiling or automatic retry of failed rows in the drain (`web/lib/persona-analysis-queue.ts` `enqueuePersonaAnalysis`, `claimNextPersonaSource`).
5. Queue recovery requeues analyzing/compiling rows older than 15 minutes. A drain continues after individual analysis failures and counts only successful analyses (`web/lib/persona-analysis-queue.ts` `recoverStaleAnalyzing`, `drainPersonaAnalysisQueue`).
6. Persona media rejects empty files and checks declared MIME type and byte size: audio ≤25 MiB (WAV/x-WAV, MPEG, MP4/x-M4A, WebM, Ogg); image ≤10 MiB (JPEG, PNG, WebP); video ≤100 MiB (MP4, WebM, QuickTime). Voice transcript ≤5,000 characters. These are media-helper limits, not source-upload limits (`web/lib/persona-media.ts` `MEDIA_LIMITS`, `checkFile`, `setPersonaVoice`).
7. Twin photo input must decode to nonempty JPEG bytes ≤2 MiB with JPEG magic bytes. Headshot styles are integer 0–3. Twin video-upload URL accepts only WebM/MP4; save validates its key shape, not object existence or duration (`web/lib/twin/avatar.ts` `decodePhoto`, `avatarVideoUpload`, `savePersonaVoice`; `web/lib/twin/trpc.ts` `avatarRouter`).
8. Library voice POST needs any org membership, configured S3, nonempty audio, and size ≤25 MiB. It does not validate MIME, duration, transcript length, or supplied name length. Blank name becomes `Untitled N`, counting all cloned rows across orgs (`web/app/api/tts/voices/route.ts`).
9. Voice rename needs a trimmed name of 1–60 characters and a same-org cloned row. Delete also requires a same-org cloned row. Sample operations return 403 when the row matches the org lookup; global samples normally miss that lookup and return 404. Delete removes storage before the DB row; it does not reject persona-owned voices or require the UI's typed-name confirmation (`web/app/api/tts/voices/[voiceId]/route.ts` PATCH/DELETE; `web/components/voice-library.tsx`).
10. No org clone is an implicit default: web fallback selection uses ready global rows ordered by name, with no `kind: sample` filter. No global fallback returns 404 from the default-voice route (`web/lib/session-activation.ts`; `web/app/api/tts/default-voice/route.ts`).
11. TTS rejects blank input, text longer than `TTS_MAX_TEXT_CHARS` (default 5,000), or formats outside WAV/PCM with 400. Resolver not-found becomes 404; web-resolution failure becomes 502. Service endpoints check `TTS_API_KEY` only if configured (`tts/app/main.py` `_check_auth`, `speech`; `tts/app/config.py`).

## Entry points

| Surface | Entry and implementation |
| --- | --- |
| Persona pages | `/personas`, `/personas/new`, `/personas/{slug}`, `/personas/{slug}/edit`: `web/app/dash/personas/**/page.tsx`; `web/components/persona/*`. `?view=spec` opens sources/baseline/YAML; `?version=N` selects historical YAML in that view. |
| Persona page data | tRPC `page.personas`, `page.persona`, `page.personaEdit`: `web/lib/pages/router.ts`; `web/lib/pages/spec-resource.ts`. |
| Persona form | POST `/api/personas`; PATCH `/api/personas/{slug}`: matching `web/app/api/personas/**/route.ts`. |
| Sources | GET/POST `/api/personas/{slug}/sources`; DELETE `/api/personas/{slug}/sources/{id}`; POST `/api/personas/{slug}/sources/{id}/analyze`: matching route files. The last two scope by source ID/org, not URL slug. |
| Synthesis | POST `/api/personas/{slug}/synthesize`: matching route, returns YAML only. |
| Persona media | POST `/api/personas/{slug}/media`; GET `/api/personas/{slug}/avatar`: matching route files. No GET media/settings REST route is defined there. |
| Advanced specs | GET `/api/spec/personas[/{slug}]`; PUT/DELETE `/api/spec/personas/{slug}`: `web/app/api/spec/[type]/[[...id]]/route.ts`. |
| Voice pages | `/voice`, `/voice/cloning`, `/voice/{voiceId}`: `web/app/dash/voice/**`; `/voice/cloning/new` redirects to cloning. Library data is tRPC `page.voices` (`web/lib/pages/router.ts`). |
| Voice REST | GET/POST `/api/tts/voices`; GET/PATCH/DELETE `/api/tts/voices/{voiceId}`; GET `/api/tts/default-voice`; POST `/api/tts/speech`: matching files in `web/app/api/tts/`. |
| Twin media | `/twin/brain/avatar`, `/twin/brain/voice`: `web/app/dash/twin/brain/**/page.tsx`. tRPC `twin.avatar.get`, `videoUploadUrl`, `headshot`, `save`, `saveVoice`: `web/lib/twin/trpc.ts`. |
| Queue pump | GET/POST `/api/internal/ingestion/pump`, cron every two minutes: `web/app/api/internal/ingestion/pump/route.ts`; `web/vercel.json`. Auth belongs to [Platform](platform.md). |
| TTS service | POST `/v1/audio/speech`, GET `/v1/models`, GET `/v1/voices`, GET `/healthz`: `tts/app/main.py`. |
| Scripts | `web/prisma/seed-voices.ts`; `web/scripts/seed-persona-presets.ts` (`--org`, optional `--client`, `--media`, `--dry-run`); `migrate-persona-voice.ts` (`--org`, `--dry-run`); `reindex-persona-sources.ts` (`--cleanup-legacy`). |

No module-specific email or webhook is sent by these persona/TTS handlers. Session webhooks belong to [Sessions](sessions.md).

## Talks to

| Module/service | Boundary |
| --- | --- |
| [Twins](twins.md), [Role plays](roleplays.md) | Receive reusable persona identity and media. Twin agents require own personas. Scenario knowledge/difficulty and skill policy stay outside this module (`web/lib/persona.ts`; split migration). |
| [Sessions](sessions.md) | Pins prompt data/version; receives live selected voice ID and signed avatar URL. Voice references/settings are not part of the persona data snapshot (`web/lib/interview-sessions.ts`; `web/lib/session-activation.ts`; `web/lib/persona-media.ts`). |
| [Voice agent and chat](voice-agent-and-chat.md) | Chat receives persona data/rendered brief; voice runtime receives a voice ID. Sarvam currently uses its configured speaker instead (`web/lib/session-context.ts`; `agent/src/tts/__init__.py`). |
| [Knowledge](knowledge.md) | Document→markdown and org-vector embedding/indexing for behavioral moments, separate from technical knowledge (`web/lib/persona-synthesis.ts`; `web/lib/main-collection.ts`). |
| S3 / [Platform](platform.md) | Raw sources, voice reference/transcript, avatar originals/candidates/image/video; signed upload/download URLs. Org prefixes or `global/` for null org media (`web/lib/s3.ts` `personaSourcePrefix`, `voicePrefix`, `avatarPrefix`). Sample seed uses the explicit `shared` prefix (`web/prisma/seed-voices.ts`). |
| Gemini / AI gateway | Media/text analysis and YAML synthesis; usage is metered for analysis/synthesis. Image gateway generates headshots (`web/lib/persona-synthesis.ts`; `web/lib/headshot.ts`). |
| Sarvam / VoxCPM2 / vLLM-Omni | Sarvam generates live-call speech by configured speaker. VoxCPM2 uses app-resolved reference audio plus optional transcript through the Python proxy (`agent/src/tts/__init__.py`; `tts/app/main.py`). |

## Edge cases and limits

- Sources have no explicit server-side size, extension allowlist, count, or per-org analysis quota in this path. Whole files are read into memory. Upload failure after row creation can leave `s3Key: pending`; no rollback is implemented (`web/lib/persona-synthesis.ts` `uploadPersonaSource`).
- The queue intends one global active slot. The active-row check is separate from candidate locking; two concurrent transactions may each see no active row and claim different rows. `SKIP LOCKED` prevents the same row being claimed, not two different rows. The comment's global single-flight guarantee needs review (`web/lib/persona-analysis-queue.ts` `claimNextPersonaSource`).
- A failed/queued source blocks automatic whole-corpus compilation. Deleting the last source leaves the existing persona data unchanged. A synthesis failure can leave a source labeled Ready but the persona YAML old (`web/lib/persona-voice.ts` `shouldRebuildPersona`; `web/lib/persona-synthesis.ts` `rebuildPersonaIfCorpusReady`).
- Index replacement deletes old moments before embedding/upsert, so an indexing failure may temporarily remove searchable evidence. Vector removal errors are swallowed; source deletion can therefore leave stale vector records (`web/lib/main-collection.ts` `ingestPersonaVoice`, `removePersonaSource`).
- Persona DELETE removes versions and source storage/index before deleting the row. An agent's restrictive FK can then block row deletion; the route maps failures to 404. Voice/avatar rows/files are not cleaned by `deleteSpec` (`web/lib/specs.ts` `deleteSpec`; `web/prisma/schema.prisma`; spec DELETE route).
- Library voice upload creates the ready row before storage succeeds and has no cleanup/failed-status handling. Twin capture's video upload, voice creation, and final link are separate requests; failed later steps can leave unused media (`web/app/api/tts/voices/route.ts`; `web/components/twin/twin-voice-capture.tsx`).
- Multi-part persona media saves voice before avatar; avatar failure does not roll back a successful voice change. Validation trusts declared file MIME except Twin's JPEG magic check (`web/app/api/personas/[slug]/media/route.ts`; `web/lib/persona-media.ts`; `web/lib/twin/avatar.ts`).
- Pace is stored, not sent to TTS or the persona brief. Interruptions/pauses/fillers are prompt descriptions, not audio timing controls (`web/lib/persona.ts` `personaBrief`; `agent/src/tts/__init__.py`; `tts/app/main.py` `SpeechRequest`).
- Speech proxy and default-voice GET have no caller authentication or rate limit in their handlers. The resolver requires `TTS_APP_KEY`; service auth is optional when `TTS_API_KEY` is unset. Do not treat voice IDs as org authorization (`web/app/api/tts/speech/route.ts`; default-voice and resolver routes; `tts/app/main.py`).
- Streaming TTS backend errors are logged and end the stream after the response has begun; callers may receive partial/empty audio under HTTP 200. Nonstreaming backend errors return 502 (`tts/app/main.py` `speech`).
- Headshots are stored as returned by the model rather than re-encoded (the `shortcut:` notes PNG size/load cost). Voice metadata caching delays reference changes up to its TTL; stale-cache fallback can outlive a signed URL (`web/lib/headshot.ts`; `tts/app/voices.py`).

## Mismatches

- `PRODUCT.md` describes immutable published persona versions, explicit human approval, and a default persona choice. Persona form/YAML saves and automatic synthesis update live persona data directly; no persona publish/default field exists. Sessions pin data, but media/settings remain mutable and unversioned (`web/lib/personas.ts`; `web/lib/specs.ts`; `web/lib/persona-synthesis.ts`; `web/prisma/schema.prisma`).
- `plans/persona-fields.md` begins with five looks, eight roles, persona difficulty, and pace in the prompt. Current code uses independent media, expanded client/interviewer/coach role groups, removes knowledge/difficulty on form save, and stores pace separately with no brief/TTS effect. Its later media model and difficulty/long-answer decisions match these newer paths (`web/lib/persona.ts`; `web/lib/persona-media.ts`).
- `plans/persona-in-chat.md` P2 is implemented: own persona identity only, selected by `isOwn`, not agent kind. Its older opening statement that chat drops editor fields is historical; current web emits meanings and chat consumes the brief (`web/lib/persona.ts` `personaBrief`; `web/lib/session-context.ts`; `chat/agent/lib/brain.ts`).
- Twin voice UI says “Your twins speak with it now,” but the default live-call provider is Sarvam and ignores the saved voice ID. Cloned-voice selection works only on the VoxCPM2 path (`web/components/twin/twin-voice-capture.tsx`; `agent/src/tts/__init__.py`).
- Default-voice comments say “shared sample voices,” but the query checks only global and ready, not kind. Voice-resolver comments describe version-driven cache updates; current `VoiceStore` caches URL/transcript by TTL and discards version (`web/app/api/tts/default-voice/route.ts`; `tts/app/voices.py`).
- Persona page comments suggest global personas fall back to a spec page, but `loadSpecResource` requires an org-scoped row and `readSpec` also reads that scope. Global persona resolution is supported for agent/session use, not this page path (`web/app/dash/personas/[slug]/page.tsx`; `web/lib/pages/router.ts` `persona`; `web/lib/pages/spec-resource.ts`; `web/lib/specs.ts` `readSpec`, `findOrgOrGlobalPersona`).

## Open questions

1. Should learner-role members be allowed to create/rename/delete org voices, and should speech proxy/default voice be public? Persona writes use studio checks, while voice management uses any membership and speech/default handlers have none (`web/app/api/personas/route.ts`; `web/app/api/tts/voices/route.ts`; voice-ID, speech, and default-voice routes).
2. Is global single-flight required under concurrent drains? The queue comment promises it, but the transaction does not lock a shared slot or serialize the active check (`web/lib/persona-analysis-queue.ts` `claimNextPersonaSource`).
3. Should historical baselines/media reflect the shown version? Historical YAML uses `readVersion`, but the baseline is current and SpecVersion contains only data, not media/settings (`web/lib/pages/spec-resource.ts`; `web/lib/persona-baseline.ts`; `web/prisma/schema.prisma`).
4. Is deleting a persona-owned voice from the general library intentional? The route permits it, the FK clears `Persona.voiceId`, and agent JSON overrides remain stale until session fallback handles them (`web/app/api/tts/voices/[voiceId]/route.ts` DELETE; `web/prisma/schema.prisma`; `web/lib/session-activation.ts`).
5. Should TTS `/v1/voices` work server-to-server? It forwards the service secret to the web collection endpoint, but that endpoint requires a browser org session rather than `TTS_APP_KEY`, unlike the individual resolver (`tts/app/main.py` `voices`; `tts/app/voices.py` `list_ids`; `web/app/api/tts/voices/route.ts` GET).

## Tests today

| Layer | Existing coverage |
| --- | --- |
| Web unit/mocked storage | `web/tests/lib/persona.test.ts`: field validation, storage round trip, presets, slugs, versioning, own-data preservation, brief meanings/identity fallback. `persona-media.test.ts`: reference storage, replacement/failure cleanup, MIME/size checks, org/global scope, settings/media reads. `persona-voice.test.ts`: moment extraction/deduplication, action metadata, clipping, episode/style/name redaction, coverage and rebuild gating. `persona-quote.test.ts`: usable trainer quotes. |
| Twin media unit/mocked storage | `web/tests/lib/twin-avatar.test.ts`: JPEG validation, video upload keys, candidate headshots, original/chosen image handling, voice ownership/video validation, link/version changes, replaced-media cleanup. |
| DB/SQL | `web/tests/lib/persona-analysis-queue.test.ts` mixes helper tests with real-DB queue ordering, active guard, stale recovery, retry reset, and failure-tolerant drain (analyzer stubbed). `web/tests/sql/persona-media.sql` checks one-to-one, org matching, and object settings in a rollback transaction on a disposable DB. |
| Flow/browser | No dedicated persona/voice flow or browser test found under `web/tests/flows` or `web/e2e`. Session/credit tests exercise activation but do not establish the full voice-priority/provider matrix. |
| Chat | `chat/tests/agent/lib/playbook.test.ts`: rendered persona brief and legacy fallback in prompt formats. |
| Python agent | `agent/tests/test_voxcpm2_tts.py`: streaming, endpoint/config defaults, unknown-voice fallback, empty voice, and error propagation. |
| Python TTS | `tts/tests/test_proxy.py`: payload shaping, cloning with/without transcript, auth, WAV header, metadata cache/invalidation. `tts/tests/test_chunking.py`: text splitting/target limits. |

Important gaps: real Gemini/gateway synthesis and failure recovery; concurrent global drains; REST permission matrix and owned-voice deletion; live voice selection (including invalid override versus valid persona); default Sarvam versus cloned-voice playback; browser permissions/capture/upload partial failures; global persona page fallback. This spec was checked against source, not a live service run.
