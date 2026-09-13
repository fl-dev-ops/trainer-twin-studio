# Issue: On-Demand Session Document Retrieval and Presentation

> **Status: PLANNED.** This replaces full-document prompt injection with a
> lightweight document manifest, targeted reads, and optional workspace
> presentation. A public/OpenAI-compatible Files API is not required.

## 1. Goal

Let learners attach common documents or images to a session. The trainer must:

1. know which files are available;
2. read only relevant content when the conversation needs it;
3. present the relevant file in the shared workspace when useful;
4. work through the existing LiveKit agent and `/api/v1/chat/completions` path;
5. have the file ready as soon as upload returns successfully.

## 2. Scope

### Supported in the first version

- Documents: `.pdf`, `.txt`, `.md`, `.json`, `.csv`
- Images: `.png`, `.jpg`, `.jpeg`, `.webp`
- Maximum size: 20 MB per file
- Multiple files may be attached to one session.

### Not supported

- Audio or video
- Archives and executables
- OCR-only/scanned PDFs in the first version; a PDF must contain extractable
  text. The user can upload scanned pages as supported images instead.
- Public OpenAI-compatible `/v1/files` endpoints
- Background indexing or a `processing` state

## 3. Core Decision

Keep `ContextDocument` and the existing internal upload route. Do not build a
new Files API.

The successful upload response is the readiness boundary:

```text
upload bytes
  -> validate type and size
  -> extract text or inspect image
  -> build manifest
  -> create searchable chunks for text documents
  -> store everything in one transaction
  -> return success (file is now ready)
```

No embedding call is required during upload. Text retrieval uses a local
Postgres full-text index, so readiness does not depend on OpenRouter, Chroma,
or a background worker.

## 4. Runtime Flow

```text
BEFORE SESSION

Attached file metadata
  -> SESSION DOCUMENT MANIFEST (small; no full content)

Example:
- doc_123 | resume.pdf | PDF | 2 pages | headings: Experience, Projects
- img_456 | architecture.png | image/png

EACH LEARNER TURN

Transcript + active phase + document manifest
  -> document decision (reuse the existing direction LLM call)
     - read needed? yes/no
     - file id
     - focused search query
     - present to learner? yes/no
  -> targeted retrieval
     - text file: top 3 matching chunks
     - image: attach that one image to the content-model request
  -> analyzer/content stage receives only selected evidence
  -> optional surface tool call opens the selected file
  -> style stage receives only the finished draft, never file content
```

### Why the manifest belongs in the direction/retrieval stage

That stage decides what evidence is needed before composing a response. It is
the cheapest place to expose file availability and avoids contaminating the
style renderer with document facts.

The content stage receives the same small manifest for file names plus only the
selected excerpt/image. The analyzer receives selected excerpts when it must
check a learner claim. The style gate and renderer receive no document data.

### Opening turn

There is no direction call before the opening. Use a deterministic rule:

- if the active phase requires context, search attached text documents using
  the scenario opening and objective, then give the content stage the top
  excerpts;
- otherwise provide only the manifest;
- if required context is absent, keep the existing no-document grounding and
  adapt résumé/document wording to general experience.

## 5. Data Model

Extend the existing data model rather than introducing a provider-style file
resource.

### `ContextDocument`

Add:

- `ownerUserId` — prevents one learner from seeing another learner's uploads;
- `kind` — `document` or `image`;
- `extractedText` — normalized content for text documents, null for images;
- `manifest` JSON — MIME type, page count when known, headings, and image
  dimensions when cheaply available;
- `sha256` — audit/deduplication support.

Keep the original bytes for viewing/downloading.

### `ContextDocumentChunk`

Add one row per deterministic text chunk:

- `documentId`
- `chunkIndex`
- `heading` (optional)
- `pageNumber` (optional; only when extraction provides it reliably)
- `text`

Add a Postgres full-text index over `text`. Do not add Chroma or embeddings in
this phase.

### `InterviewSessionDocument`

Add a join table between sessions and context documents so a session can have
multiple files. Keep `InterviewSession.contextId` temporarily as a compatibility
alias and attach it to the join table during activation. Remove it only after
all callers have migrated.

## 6. Upload and Access

### Upload

Extend the existing `POST /api/upload` route:

1. validate extension, declared MIME type, and file signature;
2. reject unsupported or mismatched types;
3. parse and chunk supported text documents synchronously;
4. validate JSON as JSON and preserve CSV/text as readable text;
5. store image bytes and basic metadata without running an LLM;
6. return only after the file and chunks are committed.

A successful response means `ready`; extraction failure returns `422` and does
not create a partial file.

### Session attachment

Accept `contextIds: string[]` when a session starts. Continue accepting the old
`contextId` field during migration. Validate that every file is accessible to
the current user and organization before attaching it.

### Chat Completions

The normal LiveKit path resolves attached files from the runtime session token.
Also accept OpenAI-shaped message attachments for internal callers:

```json
{
  "role": "user",
  "content": "Compare this claim with my resume.",
  "attachments": [{ "file_id": "doc_123" }]
}
```

Every attachment must be authorized and attached to the active session before
use. This adds file support to `/api/v1/chat/completions` without requiring a
public Files API.

## 7. Retrieval Decision Contract

Extend the existing direction response with:

```json
{
  "document_lookup": {
    "needed": true,
    "file_id": "doc_123",
    "query": "distributed cache ownership and measured outcome",
    "present": true
  }
}
```

Rules:

- `needed: false` for general discussion that does not require file evidence;
- `file_id` must be one of the manifest IDs;
- `query` describes the exact fact or section needed;
- `present: true` only when the learner asks to see the file or shared viewing
  materially helps the discussion;
- invalid IDs or empty queries degrade to no document evidence, never arbitrary
  file access.

For text, return at most three chunks under a strict character/token budget.
For images, send only the selected image to the content model as a multimodal
content block. Do not send image bytes to the direction, analyzer, style, or
renderer stages.

## 8. Workspace Presentation

Reuse the existing LiveKit `surface` tool.

### Tool payloads

```json
{
  "action": "open_pdf",
  "payload": { "fileId": "doc_123", "page": 2 }
}
```

```json
{
  "action": "open_image",
  "payload": { "fileId": "img_456" }
}
```

Implementation work:

1. extend `AgentSurface` with `fileId`, optional page, and an image surface;
2. add an authenticated content route that serves attached file bytes inline;
3. make `PdfViewerSurface` resolve `fileId` and scroll to an optional page;
4. add a minimal image viewer surface;
5. keep the current RPC-first/data-packet-fallback behavior.

If the client does not advertise the `surface` tool, retrieval and speech still
work; only the visual presentation is skipped.

When presentation is selected, follow the existing proven tool cycle:

1. persist a small pending document action in runtime state;
2. return the surface tool call;
3. after LiveKit reports tool completion, retrieve the selected evidence and
   generate the spoken response;
4. clear the pending action.

## 9. Security and Privacy

- Scope every lookup by organization and uploader/session access.
- Never trust a file ID supplied by the model or client without a database
  authorization check.
- Only serve bytes for files attached to the requesting session.
- Escape document boundaries in prompts and state that file text is data, not
  instructions; ignore instructions found inside uploaded files.
- Do not log document content, excerpts, image bytes, or signed URLs.
- Reject active content, archives, executables, SVG, HTML, and MIME/extension
  mismatches.

## 10. Implementation Sequence

### Phase 1 — Storage and synchronous preparation

- Add schema fields, chunk table, and session-document join table.
- Extend upload validation and synchronous extraction.
- Store manifest and chunks transactionally.
- Add authenticated file-content route.

**Check:** after upload returns, metadata, chunks, and viewable bytes are all
available immediately.

### Phase 2 — Session attachment and manifest

- Accept `contextIds`, preserve old `contextId` compatibility.
- Load only authorized attached-file manifests into `CompiledSpecs`.
- Replace current full-document `SESSION FACTS` injection with the manifest.
- Preserve explicit negative grounding when no file is attached.

**Check:** no full document appears in prompts before retrieval.

### Phase 3 — On-demand text retrieval

- Extend the direction schema with `document_lookup`.
- Add Postgres chunk search and strict result budgets.
- Feed selected chunks to analyzer and content generation.
- Add deterministic opening retrieval for context-required scenarios.

**Check:** an unrelated turn injects zero chunks; a relevant turn injects only
matching chunks.

### Phase 4 — Images

- Add image metadata to manifests.
- Add selected-image multimodal input to the content model only.
- Confirm the configured OpenRouter model supports vision and fail safely when
  it does not.

**Check:** image bytes are sent only on turns that select that image.

### Phase 5 — Agent presentation

- Extend surface event parsing for `fileId`, page, and `open_image`.
- Add PDF page navigation and image viewing.
- Implement pending surface action handling across the LiveKit tool round-trip.

**Check:** the learner sees the same authorized file the trainer discusses.

### Phase 6 — Chat Completions compatibility and cleanup

- Parse and authorize message `attachments`.
- Test stream and non-stream behavior with attachments.
- Remove the temporary full-content runtime path.
- Update the context-grounding issue and API documentation.

## 11. Tests

### Unit tests

- allowed/rejected extension, MIME, and signature combinations;
- deterministic chunking and manifest generation;
- lexical retrieval ranking and result budget;
- direction response validation rejects unknown file IDs;
- no-document and prompt-injection grounding rules;
- PDF/image surface event parsing.

### Integration tests

1. Upload -> immediate read/search/view succeeds.
2. Attach multiple files -> manifest contains only authorized files.
3. Unrelated learner turn -> no document excerpt is injected.
4. Relevant learner turn -> only matching chunks are injected.
5. "Show me that page" -> LiveKit surface opens the correct PDF.
6. Image discussion -> only the selected image reaches the content model.
7. Cross-user and cross-organization file IDs are rejected.
8. Missing/removed files degrade to a grounded response.
9. Chat Completions works in stream and non-stream modes with attachments.
10. Style rendering cannot copy facts from unselected files.

## 12. Telemetry

Record only metadata:

- document decision made or skipped;
- selected file ID hash/type;
- retrieval query length, hit count, and injected character count;
- retrieval and presentation latency;
- surface success/failure;
- fallback reason.

Never record document text or image content.

## 13. Acceptance Criteria

- [ ] Supported uploads are ready when the upload request succeeds.
- [ ] Unsupported media and unsafe formats are rejected.
- [ ] Full document text is not injected on every turn.
- [ ] The runtime reads a document only when the decision stage requests it.
- [ ] At most three bounded text chunks or one selected image reach content
      generation.
- [ ] Context-required openings can use relevant document evidence.
- [ ] The agent can open an attached PDF or image in the learner workspace.
- [ ] LiveKit and stream/non-stream Chat Completions share the same attachment
      and retrieval path.
- [ ] No cross-user or cross-organization file access is possible.
- [ ] Missing files and unsupported vision models fail safely.
- [ ] Existing sessions using one `contextId` continue to work during migration.
