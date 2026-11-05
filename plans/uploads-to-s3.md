# Every upload in S3, a record in the DB, the agent gets the id

Status: plan (2026-11-06). Applies to learner sessions and calibrations (LiveKit → voice agent → chat agent) and to the
copilot chat (browser → studio proxy → copilot, eve).

## Where things are today (verified)

| Upload | Stored | How the agent gets it |
|---|---|---|
| Session file, before the call (prejoin) and during it (twin / role play / calibration) | **Postgres** `ContextDocument.content` (bytes) + extracted text and chunks; linked to the session | Session data lists document ids. During a call the browser also says "I've attached a file: X (document ID …)" over `lk.chat`. The chat agent calls `read_document(id)` → studio `readDocument` → text, or the image (vision) |
| Copilot chat image (step 1, built, **not committed**) | **Nowhere**: base64 inside the message | eve copies it into the copilot sandbox (`/workspace/.eve/attachments/…`) and shows it to the model |
| Knowledge base file | S3 + `KnowledgeDocument` | copilot syncs the Markdown (`files`, `read`) |
| Call recording | S3 | not read by agents |

Facts that shape the plan:
- Uploads go through `POST /api/upload` (multipart, a Vercel function: **4.5 MB request cap**), but the upload rule
  allows 10 MB. Anything between ~4.5 MB and 10 MB likely fails in prod today.
- Prod holds 42 uploads in Postgres (40 documents, 2 images, ~2.8 MB): a backfill is small.
- The LiveKit path already passes **ids**, never bytes: agents read by id through the studio. Only storage changes there.
- eve's `fetchFile(url, { session })` can load a file the message points to (with the session, to check its caller),
  stage it, and show an image natively to the model on every turn.

## Decision: eve's option B for images in a conversation, read_document for the rest

eve's docs give three ways to get a file to an agent: (A) inline base64 file part, (B) upload to your own storage and
send a file part that points at it, resolved by the channel's `fetchFile(url, { session })`, (C) a tool returns the file.

- **Images uploaded during a conversation → B.** They arrive as file parts; eve copies them into the conversation's
  sandbox and shows them to the model on every call, no tool needed.
- **`read_document` → everything read on demand:** files uploaded before the session (session data lists their ids)
  and, if wanted, knowledge-base documents (see decision 4).
- **Never A:** large bytes stay out of messages (Vercel 4.5 MB request cap).

Both agents can do B (verified in eve's types and docs): the copilot's eve channel and the chat agent's custom
OpenAI-compatible channel both accept file parts (`source.send(message: string | UserContent)`) and both can declare
`fetchFile`, which receives the session so it can check the caller.

## Design

### 1. One record for every user upload: `ContextDocument`
- Add `s3Key String?` and `status` (`pending | ready | failed`); make `content Bytes?` nullable (migration). New
  uploads keep their bytes only in S3 at `<orgPrefix>/uploads/<docId>/<file>`; `content` stays null.
- Add `purpose` (`session | calibration | copilot`) and optional `copilotSessionId`, so a conversation's files can be
  listed later.
- One reader, `readUploadBytes(doc)`: S3 when `s3Key`, else legacy `content`. Switch every reader to it: studio
  `readDocument`, `/api/documents/[id]/raw` (viewers), `lib/resume-claims.ts` (2 places), `lib/specs.ts`.
- Images handed to a model are resized to eve's limit (3 MiB, 8000 px a side) on read (`lib/model-image.ts`).

### 2. Upload straight to S3 (no 4.5 MB cap)
1. `POST /api/uploads` `{ name, mimeType, size, purpose, sessionId? }` → per-purpose rules (session: PDF or image
   before, image during; copilot: PNG/JPEG/WebP), a `pending` record, a presigned PUT (10 min, exact type and length).
2. Browser `PUT`s to S3.
3. `POST /api/uploads/<id>/complete` → reads the object, checks the real type from its bytes, size and sha256,
   extracts text/chunks (`prepareContextDocument`), marks it `ready`; a bad file is deleted and marked `failed`.

### 3. One resolver for both agents: `trainertwin-upload://<id>`
- A file part `{ type: "file", data: new URL("trainertwin-upload://<id>"), mediaType, filename }`.
- Each agent's channel declares `fetchFile`: for that scheme it asks the studio (`readUpload`, internal, secret-auth)
  for the bytes; anything else → `null`. The studio checks the org (from the session's caller) and, for a call, that
  the upload is linked to that call's session. A refused or missing file comes back as `attachmentError(...)`, which
  the model reads as a one-line note.
- `uploadPolicy` on both channels: images only (PNG/JPEG/WebP), 5 MB.

### 4. Copilot (direct, eve channel)
- The composer uploads each pasted/dropped/picked image (2), shows it with progress, and sends the text plus one
  `trainertwin-upload://` file part per image (and `<attached-files>` with ids, so the copilot can refer to them).
- The proxy refuses upload ids that aren't this user's org's.
- The chat shows sent images through a preview route that checks the owner (eve returns a URL only for
  browser-resolvable files).

### 5. Chat agent (LiveKit → voice agent → OpenAI-compatible bridge)
- Before the call: unchanged; prejoin passes ids, the agent reads them with `read_document`.
- During the call: the browser uploads (2), links the image to the session (`/api/sessions/<id>/documents`, as
  today) and sends one marker line over `lk.chat` instead of today's sentence: `[ATTACHED <id>]`. The voice agent
  passes the text through unchanged. The bridge (`chat/agent/channels/openai-compat.ts`) turns each marker into a
  `trainertwin-upload://<id>` file part on that turn (text kept: "The learner attached an image."), so the model sees
  the image on that turn and every later one.
- A typed fake marker only reaches the learner's own session's files: `readUpload` checks the link to the session.
- Nothing to configure for files: eve stores every file the model sees (message attachments and files a tool
  returns) in the conversation's built-in sandbox, opened lazily on the first file. The chat agent already does this
  today when `read_document` returns an image, so B adds no new moving part.

### 6. Ready for the next step (sessions and calibrations in the copilot)
`read_session` / `read_calibration` return the transcript and the ids of files attached in that call; the copilot
opens them with its own `read_document` (same studio reader), which shows an image to the model.

### 7. Existing data and cleanup
- Backfill script: for each `ContextDocument` with `content` and no `s3Key`, write it to S3, set `s3Key`, null
  `content` (42 rows in prod). Run after deploy; readers handle both until then.
- Keys are org-prefixed and private; viewers get short-lived presigned GETs. Deletes stay soft (no S3 deletes).

### 8. Tests and checks
- Unit: per-purpose rules, real-type check, org check in `readUpload`, reader fallback (S3 vs legacy bytes).
- Local end to end: prejoin PDF on a twin call (agent reads it with `read_document`); during-call image (the agent
  describes it without a tool, and still knows it two turns later); a 9 MB PDF (over today's cap); copilot screenshot
  (described without a tool); another org's id and a fake marker refused.

## Decisions (2026-11-06)

1. **Sizes:** 10 MB for files uploaded before a session; during a conversation (call or copilot) images up to 5 MB and
   PDFs up to 10 MB.
2. **Copilot uploads expire after 30 days:** `ContextDocument.expiresAt` (purpose `copilot`); a daily job (the
   existing Vercel cron) deletes the S3 object and marks the record `expired`. An expired id resolves to a one-line
   note ("This file has expired."). Session and calibration uploads don't expire.
3. **PDFs and images during a conversation, both as B:** eve passes images (up to 3 MiB / 8000 px a side, resized on
   read) and PDFs (up to 20 MiB) to the model natively. The during-call upload rule widens from images to images and
   PDFs; `uploadPolicy` on both channels: PNG, JPEG, WebP, PDF, 10 MB.
4. **Separate tools:** `read_document` stays for uploads (files from before the session, by id). Knowledge-base
   documents get their own tool, `read_knowledge_document(id)` on the chat agent: the document's Markdown from S3,
   paged, org-checked. Ids come from what the agent already sees (a twin skill's items carry their source document
   ids; `search_knowledge` results carry `docId`). The copilot keeps `files` / `read` for the knowledge base.

## As built (2026-11-06, branch `uploads-s3`)

- **Storage:** `lib/uploads.ts` (start / complete / resolve / expire), `lib/upload-bytes.ts` (the one reader: S3 or
  legacy Postgres bytes), `lib/upload-access.ts` (member or invite/twin-code holder), `lib/upload-client.ts` (browser:
  start, PUT to S3, complete). Routes: `POST /api/uploads`, `POST /api/uploads/<id>/complete`,
  `GET /api/uploads/<id>/view`; `/api/upload` stays (one request, now stored in S3). Migration
  `20261106030000_context_document_s3`.
- **The presigned PUT signs the declared size:** S3 refuses a body of any other length (403), so a client can't put
  more in the bucket than the size it declared and was checked against.
- **Images over 2.5 MB or 4096 px** get a model-ready copy at upload (`<key>.model.jpg`, 2048 px JPEG) that
  `resolveUpload` hands out; eve inlines images up to 3 MiB only.
- **Copilot PDFs arrive as text, not PDF bytes (change from decision 3):** the copilot's model (Cerebras qwen) refuses
  `file` parts, and a refused part fails the whole conversation (`session.failed`). The copilot's `fetchFile` returns
  a PDF as `<name>.md` (the text extracted at upload); eve stages it and the copilot opens it with `read_file`. Images
  still reach it as pixels. The chat agent (Gemini) gets PDFs natively. Scanned PDFs have no text yet (`shortcut:`
  comment in `resolveUpload`).
- **During a call:** the browser sends `I've attached a file: <name> [ATTACHED <id>]`; the chat channel turns each
  marker into a `trainertwin-upload://<id>` file part (`chat/agent/lib/uploads.ts`), and the studio's `resolveUpload`
  checks the file is linked to that session.
- **`read_knowledge_document`** pages a knowledge document's Markdown (12k characters a page); off in role plays like
  the other knowledge tools. Twin skill items don't carry document ids yet, so ids come from `search_knowledge` only.
- **Daily cron** `/api/internal/uploads/expire` (03:30 UTC): copilot uploads past 30 days, and uploads left `pending`
  for a day (marked `failed`, S3 object deleted).
- **Backfill:** `bun scripts/backfill-uploads-s3.ts [--apply]` (verifies each S3 copy before clearing `content`).
- **Known limit:** eve's reason for a refused file (expired, not yours) reaches the model as eve's generic "retrieval
  failed" note under `eve dev` (its `instanceof` check misses our error); the refusal itself works.
